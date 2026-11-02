// findJanCandidates は jan.js、SITES は sites.js で定義されている

const RETRY_WINDOW_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 5;

// 同じサイトで同じ商品を出品している他のストアと、もう一方のサイトの価格をこの順に出す
const TARGETS =
  location.hostname === 'item.rakuten.co.jp'
    ? [{ site: 'rakuten', otherStores: true }, { site: 'yahoo' }]
    : [{ site: 'yahoo', otherStores: true }, { site: 'rakuten' }];

const PANEL_CSS = `
  :host { all: initial; display: block; }
  .container {
    box-sizing: border-box; text-align: left; color: #222;
    font: 13px/1.5 -apple-system, "Segoe UI", "Hiragino Sans", Meiryo, sans-serif;
  }
  .container > * + * { margin-top: 8px; }
  .container.inline { width: 100%; margin-top: 12px; }
  .container.floating {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    width: 320px; max-height: 70vh; overflow: auto;
  }
  .panel, .container > .variant {
    box-sizing: border-box; background: #fff; border: 1px solid #ccc; border-radius: 8px;
  }
  .floating .panel, .floating > .variant { box-shadow: 0 4px 16px rgba(0,0,0,.2); }
  .panel[hidden] { display: none; }
  .container > .variant { padding: 8px 12px; }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; background: #bf0000; color: #fff; font-weight: bold;
    border-radius: 7px 7px 0 0;
  }
  .floating .header { position: sticky; top: 0; }
  .collapsed .header { border-radius: 7px; }
  .panel.yahoo .header { background: #ff0033; }
  .title { flex: 1; }
  .pr { font-size: 10px; font-weight: normal; border: 1px solid #fff; border-radius: 3px; padding: 0 3px; }
  .header button {
    background: none; border: none; color: #fff; font-size: 14px; cursor: pointer; padding: 0 4px;
  }
  .body { padding: 8px 12px; }
  .collapsed .body { display: none; }
  .variant { display: block; font-size: 12px; color: #666; }
  .variant select { display: block; width: 100%; margin-top: 2px; font-size: 12px; }
  .lowest { font-size: 18px; font-weight: bold; color: #bf0000; }
  ul { list-style: none; margin: 4px 0; padding: 0; }
  li { padding: 4px 0; border-top: 1px solid #eee; }
  .price { font-weight: bold; }
  .meta { color: #666; font-size: 12px; }
  a { color: #0645ad; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .note { color: #666; }
  .error { color: #bf0000; }
  .links { margin-top: 4px; }
`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function link(text, href) {
  return el('a', { textContent: text, href, target: '_blank', rel: 'noopener noreferrer sponsored' });
}

function yen(n) {
  return `${Number(n).toLocaleString('ja-JP')}円`;
}

async function getCached(key) {
  const entry = (await chrome.storage.local.get(key))[key];
  return entry && Date.now() - entry.time < CACHE_TTL_MS ? entry.results : null;
}

async function setCached(key, results) {
  // 期限切れのキャッシュを掃除してから保存する
  const all = await chrome.storage.local.get(null);
  const expired = Object.keys(all).filter((k) => k.startsWith('cache:') && Date.now() - all[k].time >= CACHE_TTL_MS);
  if (expired.length) await chrome.storage.local.remove(expired);
  await chrome.storage.local.set({ [key]: { time: Date.now(), results } });
}

async function search(siteKey, jan) {
  const cacheKey = `cache:${siteKey}:${jan}`;
  const cached = await getCached(cacheKey);
  if (cached) return { results: cached };

  const res = await chrome.runtime.sendMessage({ type: 'fetchSearch', site: siteKey, jan });
  if (res.error) return res;

  const results = SITES[siteKey].parse(res.html, jan);
  if (!results) return { error: `${SITES[siteKey].label}の検索結果を読み取れませんでした` };
  results.sort((a, b) => a.price - b.price);
  await setCached(cacheKey, results);
  return { results };
}

// 商品URLは楽天市場が https://item.rakuten.co.jp/{店舗ID}/{商品コード}/、
// Yahoo!ショッピングが https://store.shopping.yahoo.co.jp/{ストアID}/{商品コード}.html
function storeIdOf(url) {
  try {
    const { hostname, pathname } = new URL(url, location.href);
    const id = pathname.split('/')[1];
    return id ? `${hostname}/${id}` : null;
  } catch {
    return null;
  }
}

// いま見ているストア以外の出品だけ残す
function excludeCurrentStore({ results, error }) {
  if (error) return { error };
  const current = storeIdOf(location.href);
  return { results: results.filter((item) => storeIdOf(item.url) !== current) };
}

// 楽天の商品ページでは「かごに追加」ボタンの表の直下、Yahoo!ショッピングの商品ページでは価格欄の直下に置く。
// どちらも見つからないページ（古い作りの楽天ページなど）では画面右下に固定表示する。
function placeContainer(host, container) {
  const cartArea = document.getElementById('rakutenLimitedId_aroundCart');
  const cartForm = cartArea?.querySelector('.normal-reserve-form');
  const yahooPriceArea = document.getElementById('prcdsp');
  if (cartForm) {
    cartForm.after(host);
  } else if (cartArea) {
    cartArea.append(host);
  } else if (yahooPriceArea) {
    yahooPriceArea.after(host);
  } else {
    container.classList.add('floating');
    document.body.append(host);
    return;
  }
  container.classList.add('inline');
}

// パネルをまとめて入れる箱をページに置く
function createContainer() {
  const host = el('div', { id: 'ext-price-compare-panel' });
  const shadow = host.attachShadow({ mode: 'open' });
  const container = el('div', { className: 'container' });
  shadow.append(el('style', { textContent: PANEL_CSS }), container);
  placeContainer(host, container);
  return container;
}

function createPanel(container, { site: siteKey, otherStores }) {
  const site = SITES[siteKey];
  const title = otherStores ? `${site.label}の他のストア` : `${site.label}の価格`;
  const toggle = el('button', { textContent: '－', title: '折りたたむ' });
  const body = el('div', { className: 'body' });
  const header = el('div', { className: 'header' }, [el('span', { className: 'title', textContent: title })]);
  if (site.isAffiliate()) {
    header.append(el('span', { className: 'pr', textContent: 'PR', title: 'このパネルのリンクはアフィリエイトリンクです' }));
  }
  header.append(toggle);
  const panel = el('div', { className: `panel ${siteKey}` }, [header, body]);
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '＋' : '－';
    toggle.title = collapsed ? '開く' : '折りたたむ';
  });
  container.append(panel);
  return { panel, body };
}

function renderResults(siteKey, { results, error }, jan) {
  const site = SITES[siteKey];
  const aff = (url) => site.affiliateUrl(url);
  const nodes = [el('div', { className: 'meta', textContent: `JAN: ${jan}（新品）` })];

  if (error) {
    nodes.push(el('div', { className: 'error', textContent: error }));
  } else if (results.length === 0) {
    nodes.push(el('div', { className: 'note', textContent: '該当なし' }));
  } else {
    nodes.push(
      el('div', {}, ['最安値 ', el('span', { className: 'lowest', textContent: yen(results[0].price) })]),
      el(
        'ul',
        {},
        results.slice(0, MAX_RESULTS).map((item) =>
          el('li', {}, [
            el('div', {}, [el('span', { className: 'price', textContent: yen(item.price) }), ' ', link(item.shop || '商品ページ', aff(item.url))]),
            el('div', { className: 'meta', textContent: [item.shipping, item.name].filter(Boolean).join(' / ') }),
          ])
        )
      )
    );
  }
  nodes.push(el('div', { className: 'links' }, [link(`${site.label}でもっと見る`, aff(site.searchUrl(jan)))]));
  return nodes;
}

async function show(candidates) {
  const container = createContainer();
  const panels = TARGETS.map((target) => {
    const { panel, body } = createPanel(container, target);
    const resultsEl = el('div');
    body.append(resultsEl);
    return { target, panel, resultsEl };
  });

  let currentJan = null;
  const loadPanel = async ({ target, panel, resultsEl }, jan) => {
    resultsEl.replaceChildren(el('div', { className: 'note', textContent: '読み込み中…' }));
    let result;
    try {
      result = await search(target.site, jan);
    } catch (e) {
      result = { error: e.message };
    }
    if (target.otherStores) result = excludeCurrentStore(result);
    // 読み込み中に別のバリエーションが選ばれたら古い結果は捨てる
    if (jan !== currentJan) return;
    // 他のストアの出品がなければパネルごと隠す
    panel.hidden = Boolean(target.otherStores && result.results?.length === 0);
    resultsEl.replaceChildren(...renderResults(target.site, result, jan));
  };
  const load = (jan) => {
    currentJan = jan;
    return Promise.all(panels.map((p) => loadPanel(p, jan)));
  };

  // 検索結果などから ?variantId= 付きで開いたときは、そのバリエーションを選ぶ
  const variantId = new URLSearchParams(location.search).get('variantId');
  const initial = candidates.find((c) => c.variantId && c.variantId === variantId) ?? candidates[0];

  if (candidates.length > 1) {
    const select = el(
      'select',
      {},
      candidates.map((c) => el('option', { value: c.jan, textContent: c.label || c.jan, selected: c === initial }))
    );
    select.addEventListener('change', () => load(select.value));
    // 他のストアのパネルが隠れても選べるよう、パネルの外の先頭に置く
    container.prepend(el('label', { className: 'variant' }, ['バリエーション', select]));
  }
  await load(initial.jan);
}

// JANが見つからず検索できない場合も、価格を出すときと同じ場所に知らせる。
// 他のストアは出品があるときだけ出すので、ここでは出さない。
function showNotFound() {
  const container = createContainer();
  for (const target of TARGETS.filter((t) => !t.otherStores)) {
    const { body } = createPanel(container, target);
    body.append(el('div', { className: 'note', textContent: 'このページから商品のJANコードを取得できなかったため、価格を検索できませんでした' }));
  }
}

function main() {
  const candidates = findJanCandidates();
  if (candidates.length) {
    show(candidates);
    return;
  }

  // 遅れて描画される部分にJANがある場合に備え、しばらく待って再試行する
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const found = findJanCandidates();
      if (found.length) {
        observer.disconnect();
        show(found);
      }
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    clearTimeout(timer);
    if (!document.getElementById('ext-price-compare-panel')) {
      const found = findJanCandidates();
      if (found.length) show(found);
      else showNotFound();
    }
  }, RETRY_WINDOW_MS);
}

main();
