// Патчим СЫРОЙ XML Тильды точечными заменами, без разбора и пересборки: именно
// такой XML 1С умеет импортировать, пересобранный ломал импорт.

// Маска телефона в 1С принимает только цифры: "+7 (999) 999-99-88" не сохраняется.
function normalizePhone(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  return digits;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// 1С материализует адрес контрагента только при наличии типизированных
// <АдресноеПоле> (одного <Представление> мало), а Тильда отдаёт адрес одной
// строкой, которую покупатель пишет как угодно — с запятыми или без. Поэтому
// сначала вынимаем однозначные части (индекс, кв., корп., дом), затем улицу по
// слову-типу, а остаток считаем городом.
//
// 1С сама дописывает тип к значению: Город "X" -> "X г", Улица "X" -> "X ул",
// Дом "N" -> "дом № N". Поэтому "г." и "ул." из ввода убираем, иначе в печати
// выйдет "г. Москва г". Прочие типы улиц ("проспект") оставляем как есть: как
// 1С отрисует их иначе, не проверено.
const BOUNDARY = '(?:^|[\\s,])';
const END = '(?=$|[\\s,])';
const NUMBER = '\\d+[а-яё]?(?:\\/\\d+)?';

const ZIP_RE = new RegExp(BOUNDARY + '(\\d{6})' + END);
const REGION_RE = new RegExp(
  BOUNDARY + '([а-яё-]+(?:ая|ий|ой|ый)\\s+(?:обл|область|край)\\.?|(?:обл|область|край)\\.?\\s+[а-яё-]+(?:ая|ий|ой|ый))' + END,
  'i'
);
const FLAT_RE = new RegExp(BOUNDARY + '(?:кв|квартира)\\.?\\s*(' + NUMBER + ')' + END, 'i');
const OFFICE_RE = new RegExp(BOUNDARY + '(оф|офис|пом|помещение)\\.?\\s*(' + NUMBER + ')' + END, 'i');
const BUILDING_RE = new RegExp(BOUNDARY + '(?:к|корп|корпус)\\.?\\s*(\\d+[а-яё]?)' + END, 'i');
const HOUSE_RE = new RegExp(BOUNDARY + '(?:д|дом)\\.?\\s*(' + NUMBER + ')' + END, 'i');
const BARE_NUMBER_RE = new RegExp(BOUNDARY + '(' + NUMBER + ')' + END, 'gi');
const CITY_PREFIX_RE = /^(?:г|гор|город)\.?\s+/i;
const COUNTRY_RE = /^(?:россия|рф|российская федерация)$/i;

const STREET_TYPES = new Set([
  'ул', 'улица', 'пр', 'пр-т', 'пр-кт', 'просп', 'проспект', 'пер', 'переулок',
  'ш', 'шоссе', 'б-р', 'бульвар', 'наб', 'набережная', 'проезд', 'пр-д', 'тракт',
  'аллея', 'пл', 'площадь', 'мкр', 'микрорайон', 'туп', 'тупик', 'линия',
]);
const isPlainStreetType = (word) => /^(?:ул|улица)$/i.test(word);
const streetTypeOf = (token) => token.toLowerCase().replace(/\.$/, '');

function parseAddressFields(address) {
  let rest = String(address).replace(/\s+/g, ' ').trim();
  const take = (re, group = 1) => {
    const m = rest.match(re);
    if (!m) return null;
    rest = rest.replace(m[0], ' , ');
    return m[group];
  };

  const zip = take(ZIP_RE);
  const region = take(REGION_RE);
  const flat = take(FLAT_RE);
  // Отдельного поля под офис в схеме нет, кладём в "Квартира" с типом в тексте,
  // чтобы в печати не вышло "кв." вместо офиса.
  const officeMatch = rest.match(OFFICE_RE);
  const office = officeMatch ? (/^оф/i.test(officeMatch[1]) ? 'оф. ' : 'пом. ') + officeMatch[2] : null;
  if (officeMatch) rest = rest.replace(officeMatch[0], ' , ');
  const building = take(BUILDING_RE);

  // Дом без "д." берём по ПОСЛЕДНЕМУ отдельному числу: в названиях улиц бывают
  // числа ("8 Марта"), а номер дома по привычке пишут в конце.
  let house = take(HOUSE_RE);
  if (!house) {
    const bare = [...rest.matchAll(BARE_NUMBER_RE)].pop();
    if (bare) {
      house = bare[1];
      rest = rest.slice(0, bare.index) + ' , ' + rest.slice(bare.index + bare[0].length);
    }
  }

  const parts = rest.split(',').map((p) => p.trim()).filter((p) => p && !COUNTRY_RE.test(p));

  let city = null;
  let street = null;
  const streetIndex = parts.findIndex((p) => p.split(' ').some((t) => STREET_TYPES.has(streetTypeOf(t))));
  if (streetIndex !== -1) {
    const tokens = parts[streetIndex].split(' ');
    const typeAt = tokens.findIndex((t) => STREET_TYPES.has(streetTypeOf(t)));
    const typeWord = tokens[typeAt];
    parts.splice(streetIndex, 1);

    if (typeAt === tokens.length - 1 && typeAt > 0) {
      const name = capitalize(tokens.slice(0, typeAt).join(' '));
      street = isPlainStreetType(streetTypeOf(typeWord)) ? name : name + ' ' + typeWord;
    } else {
      const name = capitalize(tokens.slice(typeAt + 1).join(' '));
      street = isPlainStreetType(streetTypeOf(typeWord)) ? name : typeWord + ' ' + name;
      const before = tokens.slice(0, typeAt).join(' ');
      if (before) city = before;
    }
  }

  // Без слова-типа одиночный остаток — это город ("Северодвинск"), но если
  // рядом был номер дома, то скорее улица ("Воскресенская 15").
  if (!street && parts.length === 1 && house && !city) {
    street = capitalize(parts.shift());
  }
  if (!city && parts.length) city = parts.shift();
  if (!street && parts.length) street = capitalize(parts.pop());
  if (parts.length) street = [parts.join(', '), street].filter(Boolean).join(', ');

  if (city) city = capitalize(city.replace(CITY_PREFIX_RE, ''));

  const fields = [['Страна', 'Россия']];
  if (zip) fields.push(['Почтовый индекс', zip]);
  if (region) fields.push(['Регион', capitalize(region)]);
  if (city) fields.push(['Город', city]);
  if (street) fields.push(['Улица', street]);
  if (house) fields.push(['Дом', house]);
  if (building) fields.push(['Корпус', building]);
  const room = [flat, office].filter(Boolean).join(', ');
  if (room) fields.push(['Квартира', room]);
  return fields;
}

function buildAddressNode(address, fields, indent) {
  const inner = indent + ' ';
  const lines = [indent + '<Адрес>', inner + '<Представление>' + escapeXml(address) + '</Представление>'];
  fields.forEach(([type, value]) => {
    lines.push(
      inner + '<АдресноеПоле>',
      inner + ' <Тип>' + type + '</Тип>',
      inner + ' <Значение>' + escapeXml(value) + '</Значение>',
      inner + '</АдресноеПоле>'
    );
  });
  lines.push(indent + '</Адрес>');
  return lines.join('\n') + '\n';
}

// С включённой доставкой Тильда сама шлёт пустой <Адрес> — заменяем его на месте.
// Иначе вставляем перед <Контакты>, как требует порядок элементов схемы.
function patchOrAddAddress(block, address, fields) {
  const existing = /([ \t]*)<Адрес>[\s\S]*?<\/Адрес>\n?/;
  const m = block.match(existing);
  if (m) return block.replace(existing, buildAddressNode(address, fields, m[1]));

  const before = /([ \t]*)(<Контакты>|<\/Контрагент>)/;
  const anchor = block.match(before);
  if (!anchor) return null;
  return block.replace(before, buildAddressNode(address, fields, anchor[1]) + anchor[1] + anchor[2]);
}

function paymentLabel(captured) {
  if (captured.paymentSystem === 'cash') return 'Наличные';
  return captured.paymentSystem || 'не указан';
}

function buildSummary(captured) {
  const lines = [];
  if (captured.name) lines.push('Имя: ' + captured.name);
  if (captured.isLegal && captured.orgName) lines.push('Название организации: ' + captured.orgName);
  if (captured.isLegal && captured.inn) lines.push('ИНН: ' + captured.inn);
  if (captured.phone) lines.push('Телефон: ' + captured.phone);
  if (captured.email) lines.push('Email: ' + captured.email);
  if (captured.address) lines.push('Адрес: ' + captured.address);
  lines.push('Способ оплаты: ' + paymentLabel(captured));
  return lines.join('\n');
}

function patchOrdersXml(xmlText, store) {
  if (typeof xmlText !== 'string' || !xmlText.includes('<Документ')) {
    return xmlText;
  }

  try {
    return xmlText.replace(/<Документ>[\s\S]*?<\/Документ>/g, (docBlock) => {
      const idMatch = docBlock.match(/<Ид>([^<]*)<\/Ид>/);
      const orderId = idMatch ? idMatch[1].trim() : null;
      if (!orderId) return docBlock;

      const captured = store.getOrder(orderId);
      if (!captured) {
        console.warn('Заказ', orderId, ': вебхук не пойман, отдаю данные Тильды без изменений');
        return docBlock;
      }
      return patchDocBlock(docBlock, captured, orderId);
    });
  } catch (err) {
    console.error('Не удалось пропатчить XML, отдаю оригинал без изменений:', err);
    return xmlText;
  }
}

function patchDocBlock(docBlock, captured, orderId) {
  const buyerName = captured.isLegal ? (captured.orgName || captured.name) : captured.name;
  const inn = captured.isLegal && captured.inn ? String(captured.inn).replace(/\D/g, '') : '';
  const addressFields = captured.address ? parseAddressFields(captured.address) : null;
  const problems = [];

  let out = docBlock.replace(/<Контрагенты>[\s\S]*?<\/Контрагенты>/, (block) => {
    let inner = block;

    if (buyerName) {
      const safeName = escapeXml(buyerName);
      inner = inner.replace(/<Наименование>[^<]*<\/Наименование>/g, '<Наименование>' + safeName + '</Наименование>');
      inner = inner.replace(/<ПолноеНаименование>[^<]*<\/ПолноеНаименование>/g, '<ПолноеНаименование>' + safeName + '</ПолноеНаименование>');
    }

    if (captured.email) inner = replaceContact(inner, 'Почта', captured.email);

    // 1С молча отбрасывает контакт с типом "Телефон", но принимает "ТелефонРабочий".
    if (captured.phone) {
      inner = inner.replace(
        /(<Контакт>\s*<Тип>)Телефон(<\/Тип>\s*<Значение>)[^<]*(<\/Значение>)/,
        '$1ТелефонРабочий$2' + escapeXml(normalizePhone(captured.phone)) + '$3'
      );
    }

    // Без <ОфициальноеНаименование> 1С заводит контрагента как ИП, с ним — как
    // юрлицо (оба варианта проверены). Тип выбираем по длине ИНН: 12 цифр бывает
    // только у ИП, иначе 1С отвергнет ИНН как неверной длины.
    if (captured.isLegal && buyerName && inn.length !== 12) {
      inner = insertBeforeRole(inner, '<ОфициальноеНаименование>' + escapeXml(buyerName) + '</ОфициальноеНаименование>');
    }
    if (inn) inner = insertBeforeRole(inner, '<ИНН>' + inn + '</ИНН>');

    if (addressFields) {
      const withAddress = patchOrAddAddress(inner, captured.address, addressFields);
      if (withAddress) inner = withAddress;
      else problems.push('некуда вставить адрес');
    }

    return inner;
  });

  // Комментарий именно документа: он идёт после </Контрагенты>. Внутри
  // контрагента Тильда тоже кладёт <Комментарий> (в пустой <Адрес>).
  const withComment = out.replace(
    /(<\/Контрагенты>[\s\S]*?)<Комментарий>[^<]*<\/Комментарий>/,
    (_, head) => head + '<Комментарий>' + escapeXml(buildSummary(captured)) + '</Комментарий>'
  );
  if (withComment === out) problems.push('не найден комментарий заказа');
  out = withComment;

  if (captured.paymentSystem === 'cash') {
    out = replaceReqValue(out, 'Метод оплаты', 'Наличные');
  }

  const kind = !captured.isLegal ? 'физлицо' : inn.length === 12 ? 'ИП' : 'юрлицо';
  const addressLog = addressFields ? addressFields.map(([t, v]) => t + '=' + v).join('; ') : 'нет';
  console.log('Заказ', orderId, ': подставил данные покупателя (' + kind + '), адрес: ' + addressLog);
  if (problems.length) console.warn('Заказ', orderId, ': ВНИМАНИЕ —', problems.join(', '));

  return out;
}

function insertBeforeRole(block, node) {
  return block.replace(/([ \t]*)(<Роль>)/, (_, indent, tag) => indent + node + '\n' + indent + tag);
}

function replaceReqValue(block, reqName, newValue) {
  const re = new RegExp(
    '(<ЗначениеРеквизита>\\s*<Наименование>' + reqName + '</Наименование>\\s*<Значение>)[^<]*(</Значение>)'
  );
  return block.replace(re, '$1' + escapeXml(newValue) + '$2');
}

function replaceContact(block, type, value) {
  const re = new RegExp('(<Контакт>\\s*<Тип>' + type + '</Тип>\\s*<Значение>)[^<]*(</Значение>)', 'g');
  return block.replace(re, '$1' + escapeXml(value) + '$2');
}

module.exports = { patchOrdersXml };
