// Берём СЫРОЙ XML от Тильды и точечно заменяем в нём только значения данных
// покупателя. Никакого разбора в объект и пересборки: структура, отступы,
// форматирование чисел — всё остаётся ровно таким, каким его прислала Тильда.
// Это принципиально: именно такой XML 1С уже умеет импортировать (проверено —
// прямой обмен Тильда->1С работал), а пересобранный ломал импорт.

// Маска телефона в 1С не принимает скобки, дефисы и пробелы — проверено вручную
// в карточке контрагента: "+7 (999) 999-99-88" не сохраняется, а "79999999988"
// сохраняется нормально. Поэтому перед подстановкой чистим номер до цифр.
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
        console.log('Для заказа', orderId, 'вебхук не поймали — оставляю как есть');
        return docBlock;
      }

      const patched = patchDocBlock(docBlock, captured);
      console.log('Заказ', orderId, 'подменил данными покупателя из вебхука');
      return patched;
    });
  } catch (err) {
    console.error('Не удалось пропатчить XML, отдаю оригинал без изменений:', err);
    return xmlText;
  }
}

function patchDocBlock(docBlock, captured) {
  const buyerName = captured.isLegal
    ? (captured.orgName || captured.name)
    : captured.name;

  let out = docBlock.replace(/<Контрагенты>[\s\S]*?<\/Контрагенты>/, (block) => {
    let inner = block;

    if (buyerName) {
      const safeName = escapeXml(buyerName);
      inner = inner.replace(
        /<Наименование>[^<]*<\/Наименование>/g,
        '<Наименование>' + safeName + '</Наименование>'
      );
      inner = inner.replace(
        /<ПолноеНаименование>[^<]*<\/ПолноеНаименование>/g,
        '<ПолноеНаименование>' + safeName + '</ПолноеНаименование>'
      );
    }

    if (captured.email) inner = replaceContact(inner, 'Почта', captured.email);
    if (captured.phone) {
      const normalized = normalizePhone(captured.phone);
      console.log('Телефон: из вебхука', captured.phone, '-> подставляю', normalized);
      inner = replaceContact(inner, 'Телефон', normalized);
      const check = inner.match(/<Тип>Телефон<\/Тип>\s*<Значение>([^<]*)<\/Значение>/);
      console.log('Телефон в отправляемом XML теперь:', check ? check[1] : '(тег не найден)');
    }

    return inner;
  });

  // Способ оплаты: тег "Метод оплаты" в XML от Тильды уже существует, но там
  // всегда дефолтное значение аккаунта, а не то, что реально выбрал покупатель.
  // Пока уверенно распознаём только оплату наличными — маппинг для карты ещё
  // не пойман (см. paymentSystem в вебхуке), поэтому остальные значения не трогаем,
  // чтобы не подставить туда неверный текст.
  if (captured.paymentSystem === 'cash') {
    out = replaceReqValue(out, 'Метод оплаты', 'Наличные');
    const check = out.match(/<Наименование>Метод оплаты<\/Наименование>\s*<Значение>([^<]*)<\/Значение>/);
    console.log('Метод оплаты в отправляемом XML теперь:', check ? check[1] : '(тег не найден)');
  }

  return out;
}

// Меняем <Значение> у конкретного <ЗначениеРеквизита> по имени в <Наименование>,
// не трогая остальные реквизиты в списке
function replaceReqValue(block, reqName, newValue) {
  const re = new RegExp(
    '(<ЗначениеРеквизита>\\s*<Наименование>' + reqName + '</Наименование>\\s*<Значение>)[^<]*(</Значение>)'
  );
  return block.replace(re, '$1' + escapeXml(newValue) + '$2');
}

// Меняем <Значение> внутри конкретного <Контакт> нужного типа, не трогая остальное
function replaceContact(block, type, value) {
  const re = new RegExp(
    '(<Контакт>\\s*<Тип>' + type + '</Тип>\\s*<Значение>)[^<]*(</Значение>)',
    'g'
  );
  return block.replace(re, '$1' + escapeXml(value) + '$2');
}

module.exports = { patchOrdersXml };
