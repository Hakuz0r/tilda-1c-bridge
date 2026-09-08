require('dotenv').config();
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
      console.warn('Вебхук без orderid, игнорирую:', body);
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

// Забираем настоящий XML заказов у Тильды и подменяем в нём данные покупателя
async function handleSaleQuery(req, res) {
  const url = new URL(TILDA_URL);
  url.searchParams.set('type', 'sale');
  url.searchParams.set('mode', 'query');

  const upstream = await fetch(url, {
    headers: { Authorization: tildaAuthHeader() },
  });
  const xmlText = await upstream.text();

  console.log('--- RAW XML от Тильды (type=sale&mode=query) ---');
  console.log(xmlText);
  console.log('--- конец RAW XML ---');

  const patched = patchOrdersXml(xmlText, store);

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
    // checkauth, success и всё остальное — просто пробрасываем настоящей Тильде
    return await proxyToTilda(req, res);
  } catch (err) {
    console.error('Ошибка обработки запроса от 1С:', err);
    res.status(500).send('failure Internal bridge error');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Bridge запущен, порт', PORT);
});
