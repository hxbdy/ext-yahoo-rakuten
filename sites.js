// サイトごとの検索URL・検索結果の読み取り・アフィリエイトリンク。
// content script と background (importScripts) から読み込まれる。

// 楽天ウェブサービスで発行されたアフィリエイトID
const RAKUTEN_AFFILIATE_ID = '5905da82.9c82628c.5905da83.9146430e';

// バリューコマースで発行された Yahoo!ショッピング用のサイトID・プログラムID
const VALUECOMMERCE_SID = '3786417';
const VALUECOMMERCE_PID = '892739510';

const YAHOO_SHIPPING_LABELS = { 2: '送料無料', 3: '条件付き送料無料' };

// Yahoo!ショッピングの検索ページに埋め込まれた __NEXT_DATA__ から商品を取り出す。
// ページの構造が想定と違うときは null を返す。
function parseYahooSearch(html, jan) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const script = doc.getElementById('__NEXT_DATA__');
  if (!script) return null;

  let data;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return null;
  }
  const bff = data?.props?.initialState?.bff;
  if (!bff) return null;

  // 0件のときは searchResults が null になる
  return Object.values(bff.searchResults?.items ?? {})
    .flat()
    .filter((block) => block?.type === 'RESULT')
    .flatMap((block) => block.content?.items ?? [])
    // キーワード一致で別商品が混ざるので、JANが一致するものだけ残す
    .filter((it) => it.janCode === jan && typeof it.price === 'number' && !it.labels?.hasNoStock && !it.labels?.hasUsed)
    .map((it) => ({
      name: it.name ?? '',
      price: it.price,
      url: it.url.split('?')[0],
      shop: it.store?.name ?? '',
      shipping: YAHOO_SHIPPING_LABELS[it.shippingCode] ?? '',
    }));
}

// 楽天市場の検索ページの商品カード (.searchresultitem) から商品を取り出す
function parseRakutenSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results = [];
  for (const card of doc.querySelectorAll('.searchresultitem[data-card-type="item"]')) {
    const title = card.querySelector('a[class*="title-link--"]');
    const price = Number(card.dataset.trackPrice);
    if (!title || !price) continue;
    results.push({
      name: title.textContent.trim(),
      price,
      url: title.getAttribute('href'),
      shop: card.querySelector('a[href^="https://www.rakuten.co.jp/"]')?.textContent.trim() ?? '',
      shipping: card.querySelector('[class*="free-shipping-label--"]')?.textContent.trim() ?? '',
    });
  }
  return results;
}

const SITES = {
  yahoo: {
    label: 'Yahoo!ショッピング',
    // X=2: 価格の安い順, used=2: 新品のみ
    searchUrl: (jan) => `https://shopping.yahoo.co.jp/search?p=${jan}&X=2&used=2`,
    parse: parseYahooSearch,
    isAffiliate: () => true,
    affiliateUrl: (url) =>
      `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${VALUECOMMERCE_SID}&pid=${VALUECOMMERCE_PID}&vc_url=${encodeURIComponent(url)}`,
  },
  rakuten: {
    label: '楽天市場',
    // s=2: 価格の安い順, used=0: 新品のみ
    searchUrl: (jan) => `https://search.rakuten.co.jp/search/mall/${jan}/?s=2&used=0`,
    parse: parseRakutenSearch,
    isAffiliate: () => true,
    affiliateUrl: (url) =>
      `https://hb.afl.rakuten.co.jp/hgc/${RAKUTEN_AFFILIATE_ID}/?pc=${encodeURIComponent(url)}&m=${encodeURIComponent(url)}`,
  },
};
