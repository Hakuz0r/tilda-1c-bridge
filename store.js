// Очень простое хранилище: заказ -> данные покупателя из вебхука.
// Живёт в JSON-файле на диске. Для объёма в несколько заказов в день этого достаточно.
// Если Render "усыпит" сервис между заказом и синхронизацией в 1С — файл сохранится,
// так как диск живёт, пока жив контейнер (пропадает только при полном передеплое).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'orders-cache.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveOrder(orderId, data) {
  const all = loadAll();
  all[String(orderId)] = data;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function getOrder(orderId) {
  const all = loadAll();
  return all[String(orderId)];
}

function markDelivered(orderId) {
  const all = loadAll();
  if (all[String(orderId)]) {
    all[String(orderId)].delivered = true;
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  }
}

module.exports = { saveOrder, getOrder, markDelivered, loadAll };
