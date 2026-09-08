// Здесь мы берём НАСТОЯЩИЙ XML заказа, который отдаёт Тильда (там уже верно всё,
// кроме данных о покупателе), и точечно подменяем блок покупателя на то, что
// реально поймал наш вебхук.
//
// ВАЖНО: названия тегов ниже (Контрагенты/Контрагент/Наименование/Контакты и т.д.)
// соответствуют стандартной схеме CommerceML v2. Это наиболее распространённый вариант,
// но точные названия тегов, которые использует конкретно ваша 1С, мы увидим только
// после первого реального запроса (он логируется в консоль на Render — вкладка Logs).
// Если после первого теста поля покупателя не подтянутся — открой Logs, найди блок
// "RAW XML от Тильды" и пришли его мне, поправлю теги под реальную структуру за 5 минут.

const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
};

function patchOrdersXml(xmlText, store) {
  try {
    const parser = new XMLParser(parserOptions);
    const doc = parser.parse(xmlText);

    const root = doc['КоммерческаяИнформация'];
    if (!root) {
      console.warn('XML не похож на CommerceML, отдаю как есть');
      return xmlText;
    }

    let documents = root['Документ'];
    if (!documents) return xmlText;

    const wasArray = Array.isArray(documents);
    if (!wasArray) documents = [documents];

    for (const document of documents) {
      const orderId = document['Ид'] ?? document['Номер'];
      const captured = store.getOrder(orderId);
      if (!captured) {
        console.log('Для заказа', orderId, 'вебхук не поймали — оставляю как есть');
        continue;
      }
      patchOneDocument(document, captured);
      console.log('Заказ', orderId, 'подменил данными покупателя из вебхука');
    }

    root['Документ'] = wasArray ? documents : documents[0];

    const builder = new XMLBuilder({ ...parserOptions, format: true });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(doc);
  } catch (err) {
    console.error('Не удалось пропатчить XML, отдаю оригинал без изменений:', err);
    return xmlText;
  }
}

function patchOneDocument(document, captured) {
  const buyerName = captured.isLegal ? (captured.orgName || captured.name) : captured.name;

  let contragents = document['Контрагенты'] && document['Контрагенты']['Контрагент'];
  if (contragents) {
    const wasArray = Array.isArray(contragents);
    if (!wasArray) contragents = [contragents];

    for (const c of contragents) {
      if (buyerName) {
        c['Наименование'] = buyerName;
        c['ПолноеНаименование'] = buyerName;
      }
      if (captured.isLegal && captured.inn) {
        c['ИНН'] = captured.inn;
      }

      let contacts = c['Контакты'] && c['Контакты']['Контакт'];
      if (contacts) {
        const contactsWasArray = Array.isArray(contacts);
        if (!contactsWasArray) contacts = [contacts];

        for (const contact of contacts) {
          if (contact['Тип'] === 'Почта' && captured.email) contact['Значение'] = captured.email;
          if (contact['Тип'] === 'Телефон' && captured.phone) contact['Значение'] = captured.phone;
        }
        c['Контакты']['Контакт'] = contactsWasArray ? contacts : contacts[0];
      }
    }
    document['Контрагенты']['Контрагент'] = wasArray ? contragents : contragents[0];
  }

  let values = document['Значения'] && document['Значения']['ЗначениеРеквизита'];
  if (values) {
    const wasArray = Array.isArray(values);
    if (!wasArray) values = [values];

    for (const v of values) {
      const label = String(v['Наименование'] || '').toLowerCase();
      if (label.includes('адрес') && captured.address) {
        v['Значение'] = captured.address;
      }
      if (label.includes('оплат') && captured.paymentSystem) {
        v['Значение'] = captured.paymentSystem === 'cash' ? 'Наличными при получении' : 'Оплата картой';
      }
    }
    document['Значения']['ЗначениеРеквизита'] = wasArray ? values : values[0];
  }
}

module.exports = { patchOrdersXml };
