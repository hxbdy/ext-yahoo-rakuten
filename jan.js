// JANコードの抽出と検証。content.js より先に読み込まれる。

function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 8桁/13桁のモジュラス10チェック
function isValidJan(code) {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  // チェックディジットの左隣から順に重み 3, 1, 3, 1, ...
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

function normalizeJan(value) {
  if (value == null) return null;
  const code = toHalfWidthDigits(String(value)).replace(/\s/g, '');
  return isValidJan(code) ? code : null;
}

// JSON-LD の中から gtin13 / gtin / gtin8 を探す
function findJanInJsonLd(doc) {
  const keys = ['gtin13', 'gtin', 'gtin8'];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const key of keys) {
        const found = normalizeJan(node[key]);
        if (found) return found;
      }
      for (const child of Object.values(node)) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const found = walk(JSON.parse(script.textContent));
      if (found) return found;
    } catch {
      // 壊れたJSON-LDは無視する
    }
  }
  return null;
}

function findJanInMicrodata(doc) {
  for (const el of doc.querySelectorAll('[itemprop^="gtin"]')) {
    const found = normalizeJan(el.getAttribute('content') || el.textContent);
    if (found) return found;
  }
  return null;
}

const JAN_TEXT_PATTERN = /JAN(?:\s*\/\s*ISBN)?(?:\s*コード|\s*CODE)?\s*[:：]?\s*([0-9０-９]{13}|[0-9０-９]{8})(?![0-9０-９])/gi;

function findJanInText(text) {
  for (const match of text.matchAll(JAN_TEXT_PATTERN)) {
    const found = normalizeJan(match[1]);
    if (found) return found;
  }
  return null;
}

function findJan(doc = document) {
  return (
    findJanInJsonLd(doc) ||
    findJanInMicrodata(doc) ||
    findJanInText(doc.body ? doc.body.innerText : '')
  );
}

// 楽天の商品ページは、バリエーション(SKU)ごとのJANを #item-page-app-data のJSONに articleNumber として持つ。
// セット品など単体のJANがないSKUは除く。
function findRakutenSkuJans(doc) {
  const script = doc.getElementById('item-page-app-data');
  if (!script) return [];

  let data;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return [];
  }
  const skus = data?.api?.data?.itemInfoSku?.sku ?? data?.newApi?.itemInfoSku?.sku ?? [];

  const byJan = new Map();
  for (const sku of skus) {
    const jan = normalizeJan(sku?.articleNumber?.value);
    if (!jan || sku.hidden || byJan.has(jan)) continue;
    byJan.set(jan, { jan, variantId: sku.variantId, label: (sku.selectorValues ?? []).join(' / ') });
  }
  return [...byJan.values()].sort((a, b) => String(a.variantId).localeCompare(String(b.variantId)));
}

// 検索に使えるJANの候補。バリエーションごとにJANがある商品は複数返す。
function findJanCandidates(doc = document) {
  const skuJans = findRakutenSkuJans(doc);
  if (skuJans.length) return skuJans;
  const jan = findJan(doc);
  return jan ? [{ jan, variantId: null, label: '' }] : [];
}

if (typeof module !== 'undefined') {
  module.exports = { isValidJan, normalizeJan, findJanInText };
}
