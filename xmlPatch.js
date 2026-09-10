// Берём СЫРОЙ XML от Тильды и точечно заменяем в нём только значения данных
// покупателя. Никакого разбора в объект и пересборки: структура, отступы,
// форматирование чисел — всё остаётся ровно таким, каким его прислала Тильда.
// Это принципиально: именно такой XML 1С уже умеет импортировать (проверено —
// прямой обмен Тильда->1С работал), а пересобранный ломал импорт.

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

  return docBlock.replace(/<Контрагенты>[\s\S]*?<\/Контрагенты>/, (block) => {
    let out = block;

    if (buyerName) {
      const safeName = escapeXml(buyerName);
      out = out.replace(
        /<Наименование>[^<]*<\/Наименование>/g,
        '<Наименование>' + safeName + '</Наименование>'
      );
      out = out.replace(
        /<ПолноеНаименование>[^<]*<\/ПолноеНаименование>/g,
        '<ПолноеНаименование>' + safeName + '</ПолноеНаименование>'
      );
    }

    if (captured.email) out = replaceContact(out, 'Почта', captured.email);
    if (captured.phone) out = replaceContact(out, 'Телефон', captured.phone);

    return out;
  });
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
