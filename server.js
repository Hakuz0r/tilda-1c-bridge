require('dotenv').config();
const express = require('express');
const store = require('./store');
const { patchOrdersXml } = require('./xmlPatch');

const app = express();
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// Логин/пароль, которые вводятся в 1С в настройках обмена с сайтом
const AUTH_USER = process.env.AUTH_USER || 'bridge';
const AUTH_PASS = process.env.AUTH_PASS || 'change-me';

const TILDA_URL = 'https://store.tilda.ru/connectors/commerceml/';
const TILDA_USER = process.env.TILDA_USER;
const TILDA_PASS = process.env.TILDA_PASS;

app.get('/', (req, res) => {
  res.send('Tilda-1C bridge работает');
});

app.post('/webhook/tilda-order', (req, res) => {
  const receivedAt = new Date().toISOString();
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
      // Тело целиком — только здесь: без него не понять, что прислала Тильда.
      console.warn('Вебхук без orderid (' + receivedAt + '), игнорирую. Тело:', JSON.stringify(body));
      return res.status(200).send('ok');
    }

    const isLegal = String(body['Физическое_лицоЮридическое_лицо'] || '')
      .toLowerCase()
      .includes('юридич');
    const pick = (primary, fallback) => body[primary] || body[fallback] || null;

    store.saveOrder(orderId, {
      orderId: String(orderId),
      isLegal,
      name: isLegal ? body['Name_2'] : body['Name'],
      orgName: isLegal ? body['Name_3'] : null,
      inn: isLegal ? body['ИНН'] : null,
      email: isLegal ? pick('Email_2', 'Email') : pick('Email', 'Email_2'),
      phone: isLegal ? pick('Phone_2', 'Phone') : pick('Phone', 'Phone_2'),
      address: isLegal ? body['Адрес_доставки_2'] : body['Адрес_доставки'],
      paymentSystem: body['paymentsystem'] || null,
      amount: payment.amount,
      rawProducts: payment.products,
      capturedAt: receivedAt,
    });
    console.log('Вебхук заказа', orderId, 'получен', receivedAt, isLegal ? '(юрлицо)' : '(физлицо)');
    res.status(200).send('ok');
  } catch (err) {
    console.error('Ошибка обработки вебхука:', err);
    // 200 в любом случае, чтобы Тильда не заваливала повторами
    res.status(200).send('ok');
  }
});

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

// Без отдельного checkauth для sale Тильда отвечает на query "failure / Auth required".
async function tildaSaleCheckAuth() {
  const url = new URL(TILDA_URL);
  url.searchParams.set('type', 'sale');
  url.searchParams.set('mode', 'checkauth');

  const upstream = await fetch(url, {
    headers: { Authorization: tildaAuthHeader() },
  });
  const text = await upstream.text();

  const lines = text.trim().split('\n').map((l) => l.trim());
  if (lines[0] !== 'success') {
    throw new Error('Tilda checkauth для sale не вернула success: ' + lines[0]);
  }
  return { cookieName: lines[1], cookieValue: lines[2] };
}

// Тильда отдаёт каждый заказ только один раз. Держим порцию до mode=success от
// 1С и переотдаём её при повторных query — иначе при сбое импорта заказы пропадут.
let pendingSaleXml = null;

function orderIdsOf(xmlText) {
  return [...xmlText.matchAll(/<Документ>\s*<Ид>([^<]*)<\/Ид>/g)].map((m) => m[1].trim());
}

async function handleSaleQuery(req, res) {
  if (pendingSaleXml) {
    console.log('Порция заказов ещё не подтверждена 1С — отдаю повторно:', orderIdsOf(pendingSaleXml).join(', '));
    return res
      .status(200)
      .set('Content-Type', 'application/xml; charset=utf-8')
      .send(patchOrdersXml(pendingSaleXml, store));
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
  }

  const upstream = await fetch(url, { headers });
  const xmlText = await upstream.text();

  if (xmlText.includes('<Документ')) {
    pendingSaleXml = xmlText;
    console.log('Тильда отдала заказы:', orderIdsOf(xmlText).join(', '));
  } else {
    console.log('Новых заказов у Тильды нет');
  }

  res
    .status(upstream.status)
    .set('Content-Type', 'application/xml; charset=utf-8')
    .send(patchOrdersXml(xmlText, store));
}

app.all('/connectors/commerceml/', checkAuth, async (req, res) => {
  const { type, mode } = req.query;
  console.log('Запрос от 1С:', req.method, type, mode);

  try {
    if (type === 'sale' && mode === 'query') {
      return await handleSaleQuery(req, res);
    }
    if (type === 'sale' && mode === 'success' && pendingSaleXml) {
      console.log('1С подтвердила приём заказов:', orderIdsOf(pendingSaleXml).join(', '));
      pendingSaleXml = null;
    }
    return await proxyToTilda(req, res);
  } catch (err) {
    console.error('Ошибка обработки запроса от 1С:', err);
    res.status(500).send('failure Internal bridge error');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Bridge запущен, порт', PORT);
});
