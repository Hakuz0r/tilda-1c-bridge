require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./store');
const { patchOrdersXml } = require('./xmlPatch');

const app = express();
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// Логин/пароль, которые вводим в 1С (новые, свои — не обязаны совпадать со старыми)
const AUTH_USER = process.env.AUTH_USER || 'bridge';
const AUTH_PASS = process.env.AUTH_PASS || 'change-me';

// Настоящие данные Тильды, чтобы прокладка сама могла ходить за каталогом и заказами
const TILDA_URL = 'https://store.tilda.ru/connectors/commerceml/';
const TILDA_USER = process.env.TILDA_USER;
const TILDA_PASS = process.env.TILDA_PASS;

// ---------- healthcheck, чтобы видеть в браузере, что сервис живой ----------
app.get('/', (req, res) => {
  res.send('Tilda-1C bridge работает');
});

// ---------- Приём вебхука от формы заказа Тильды ----------
app.post('/webhook/tilda-order', (req, res) => {
  // ДИАГНОСТИКА карты: логируем ПОЛНОЕ сырое тело каждого входящего вебхука,
  // с таймстампом, даже если ниже не найдётся orderid — иначе при оплате
  // картой (заказ приходит в 1С пустым) невозможно понять, приходит вебхук
  // вообще или нет, и что реально лежит в теле.
  const receivedAt = new Date().toISOString();
  console.log('--- Вебхук от Тильды получен', receivedAt, '---');
  console.log(JSON.stringify(req.body));
  console.log('--- конец тела вебхука ---');

  try {
    const body = req.body;
    let payment = {};
    try {
      payment = JSON.parse(body.payment || '{}');
    } catch (e) {
      console.warn('Не смог распарсить body.payment:', body.payment);
    }

    const orderId = payment.orderid;
    if (!orderId) {
      console.warn('Вебхук без orderid (получен', receivedAt + '), игнорирую — см. полное тело выше');
      return res.status(200).send('ok');
    }

    const isLegal = String(body['Физическое_лицоЮридическое_лицо'] || '')
      .toLowerCase()
      .includes('юридич');

    const normalized = {
      orderId: String(orderId),
      isLegal,
      name: isLegal ? body['Name_2'] : body['Name'],
      orgName: isLegal ? body['Name_3'] : null,
      inn: isLegal ? body['ИНН'] : null,
      email: body['Email'] || body['Email_2'] || null,
      phone: body['Phone'] || body['Phone_2'] || null,
      address: isLegal ? body['Адрес_доставки_2'] : body['Адрес_доставки'],
      paymentSystem: body['paymentsystem'] || null,
      amount: payment.amount,
      rawProducts: payment.products,
      capturedAt: new Date().toISOString(),
    };

    store.saveOrder(orderId, normalized);
    console.log('Поймал вебхук заказа', orderId, JSON.stringify(normalized));
    res.status(200).send('ok');
  } catch (err) {
    console.error('Ошибка обработки вебхука:', err);
    // Отвечаем 200 в любом случае, чтобы Тильда не заваливала повторами
    res.status(200).send('ok');
  }
});

// ---------- Basic Auth для запросов от 1С ----------
function checkAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="commerceml"');
    return res.status(401).send('failure Authorization required');
  }
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (user !== AUTH_USER || pass !== AUTH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="commerceml"');
    return res.status(401).send('failure Wrong credentials');
  }
  next();
}

function tildaAuthHeader() {
  return 'Basic ' + Buffer.from(`${TILDA_USER}:${TILDA_PASS}`).toString('base64');
}

// Прозрачный проброс запроса на настоящую Тильду (для каталога и служебных вызовов)
async function proxyToTilda(req, res) {
  const url = new URL(TILDA_URL);
  Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));

  const isBodyMethod = ['POST', 'PUT'].includes(req.method);
  const upstream = await fetch(url, {
    method: req.method,
    headers: {
      Authorization: tildaAuthHeader(),
      'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
    },
    body: isBodyMethod ? rawBodyFrom(req) : undefined,
  });

  const text = await upstream.text();
  res.status(upstream.status).send(text);
}

function rawBodyFrom(req) {
  if (req.is('application/json')) return JSON.stringify(req.body);
  return new URLSearchParams(req.body || {}).toString();
}

// Заказы у настоящей Тильды требуют отдельной сессии: сначала checkauth именно
// для sale, который выдаёт временную куку, и только с ней Тильда отдаёт реальный
// XML заказов. Без этого шага query падает с "failure / Auth required".
async function tildaSaleCheckAuth() {
  const url = new URL(TILDA_URL);
  url.searchParams.set('type', 'sale');
  url.searchParams.set('mode', 'checkauth');

  const upstream = await fetch(url, {
    headers: { Authorization: tildaAuthHeader() },
  });
  const text = await upstream.text();

  console.log('--- Ответ Тильды на sale checkauth ---');
  console.log(text);
  console.log('--- конец ответа checkauth ---');

  const lines = text.trim().split('\n').map((l) => l.trim());
  if (lines[0] !== 'success') {
    throw new Error('Tilda checkauth для sale не вернула success: ' + text);
  }
  return { cookieName: lines[1], cookieValue: lines[2] };
}

// Последняя порция заказов, которую мы забрали у Тильды, но 1С ещё НЕ подтвердила
// приём (не прислала mode=success). Тильда отдаёт каждый заказ только один раз,
// поэтому держим порцию у себя и переотдаём её при повторных query — иначе при
// любом сбое импорта в 1С заказы теряются навсегда.
let pendingSaleXml = null;

function hasOrders(xmlText) {
  return typeof xmlText === 'string' && xmlText.includes('<Документ');
}

// Для диагностики адреса нужен реальный XML заказа с ПОЛНОСТЬЮ заполненными
// полями (и физ-, и юрлица), чтобы увидеть блок <Значения> целиком. Считаем
// заказ полностью заполненным, если пойманы все контактные поля (плюс ИНН и
// название организации для юрлица).
function isFullyFilled(captured) {
  if (!captured) return false;
  if (!(captured.phone && captured.email && captured.address)) return false;
  if (captured.isLegal) return !!(captured.orgName && captured.inn);
  return !!captured.name;
}

// Папка вне git (см. .gitignore) — просто складываем туда сырые XML таких
// заказов на диск Render, чтобы забрать их потом (например, через Render Shell)
// и прислать мне для разбора структуры полей.
const RAW_ORDERS_DIR = path.join(__dirname, 'raw-orders');

function saveRawOrderIfComplete(orderId, docBlock) {
  const captured = store.getOrder(orderId);
  if (!isFullyFilled(captured)) return;

  try {
    fs.mkdirSync(RAW_ORDERS_DIR, { recursive: true });
    const file = path.join(RAW_ORDERS_DIR, orderId + '.xml');
    fs.writeFileSync(file, docBlock);
    console.log('Сохранил сырой XML полностью заполненного заказа', orderId, '->', file);
  } catch (err) {
    console.error('Не удалось сохранить сырой XML заказа', orderId, ':', err.message);
  }
}

function extractDocuments(xmlText) {
  const docs = [];
  const re = /<Документ>[\s\S]*?<\/Документ>/g;
  let m;
  while ((m = re.exec(xmlText))) {
    const idMatch = m[0].match(/<Ид>([^<]*)<\/Ид>/);
    if (idMatch) docs.push({ orderId: idMatch[1].trim(), docBlock: m[0] });
  }
  return docs;
}

// Забираем настоящий XML заказов у Тильды и подменяем в нём данные покупателя
async function handleSaleQuery(req, res) {
  // Если прошлая порция ещё не подтверждена 1С — отдаём её снова, к Тильде не идём
  if (pendingSaleXml) {
    console.log('Есть неподтверждённая порция заказов — отдаю её повторно, Тильду не трогаю');
    const patchedAgain = patchOrdersXml(pendingSaleXml, store);
    return res
      .status(200)
      .set('Content-Type', 'application/xml; charset=utf-8')
      .send(patchedAgain);
  }

  const url = new URL(TILDA_URL);
  url.searchParams.set('type', 'sale');
  url.searchParams.set('mode', 'query');

  const headers = { Authorization: tildaAuthHeader() };

  try {
    const { cookieName, cookieValue } = await tildaSaleCheckAuth();
    if (cookieName && cookieValue) {
      headers.Cookie = `${cookieName}=${cookieValue}`;
    }
  } catch (err) {
    console.error('Не удалось получить сессию sale у Тильды:', err.message);
    // пробуем без куки — вдруг всё же хватит Basic Auth
  }

  const upstream = await fetch(url, { headers });
  const xmlText = await upstream.text();

  console.log('--- RAW XML от Тильды (type=sale&mode=query) ---');
  console.log(xmlText);
  console.log('--- конец RAW XML ---');

  if (hasOrders(xmlText)) {
    pendingSaleXml = xmlText;
    console.log('Запомнил порцию заказов до подтверждения от 1С');
    extractDocuments(xmlText).forEach(({ orderId, docBlock }) => saveRawOrderIfComplete(orderId, docBlock));
  } else {
    console.log('Тильда вернула пустой список заказов (новых нет)');
  }

  const patched = patchOrdersXml(xmlText, store);

  console.log('Отдаю 1С XML, длина:', Buffer.byteLength(patched, 'utf8'), 'байт');

  res.status(upstream.status).set('Content-Type', 'application/xml; charset=utf-8').send(patched);
}

// ---------- Эндпоинт, на который смотрит 1С ----------
app.all('/connectors/commerceml/', checkAuth, async (req, res) => {
  const { type, mode } = req.query;
  console.log('Запрос от 1С:', req.method, type, mode);

  try {
    if (type === 'catalog') {
      return await proxyToTilda(req, res);
    }
    if (type === 'sale' && mode === 'query') {
      return await handleSaleQuery(req, res);
    }
    if (type === 'sale' && mode === 'success') {
      // 1С подтвердила, что приняла порцию — только теперь можно её забыть
      if (pendingSaleXml) {
        console.log('1С подтвердила приём заказов — очищаю кэш порции');
        pendingSaleXml = null;
      }
      return await proxyToTilda(req, res);
    }
    // checkauth и всё остальное — просто пробрасываем настоящей Тильде
    return await proxyToTilda(req, res);
  } catch (err) {
    console.error('Ошибка обработки запроса от 1С:', err);
    res.status(500).send('failure Internal bridge error');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Bridge запущен, порт', PORT);
});
