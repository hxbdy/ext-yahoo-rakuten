// findJanCandidates は jan.js、SITES は sites.js で定義されている

const RETRY_WINDOW_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 5;

// 楽天のページには Yahoo の価格を、Yahoo のページには楽天の価格を出す
const TARGET_SITE = location.hostname === 'item.rakuten.co.jp' ? 'yahoo' : 'rakuten';

const PANEL_CSS = `
  :host { all: initial; display: block; }
  .panel {
    box-sizing: border-box; text-align: left;
    background: #fff; color: #222; border: 1px solid #ccc; border-radius: 8px;
    font: 13px/1.5 -apple-system, "Segoe UI", "Hiragino Sans", Meiryo, sans-serif;
  }
  .panel.inline { width: 100%; margin-top: 12px; }
  .panel.floating {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    width: 320px; max-height: 70vh; overflow: auto;
    box-shadow: 0 4px 16px rgba(0,0,0,.2);
  }
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
  .variant { display: block; margin-bottom: 6px; font-size: 12px; color: #666; }
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

async function search(jan) {
  const cacheKey = `cache:${TARGET_SITE}:${jan}`;
  const cached = await getCached(cacheKey);
  if (cached) return { results: cached };

  const res = await chrome.runtime.sendMessage({ type: 'fetchSearch', site: TARGET_SITE, jan });
  if (res.error) return res;

  const results = SITES[TARGET_SITE].parse(res.html, jan);
  if (!results) return { error: `${SITES[TARGET_SITE].label}の検索結果を読み取れませんでした` };
  results.sort((a, b) => a.price - b.price);
  await setCached(cacheKey, results);
  return { results };
}

// 楽天の商品ページでは「かごに追加」ボタンの表の直下、Yahoo!ショッピングの商品ページでは価格欄の直下に置く。
// どちらも見つからないページ（古い作りの楽天ページなど）では画面右下に固定表示する。
function placePanel(host, panel) {
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
    panel.classList.add('floating');
    document.body.append(host);
    return;
  }
  panel.classList.add('inline');
}

function createPanel() {
  const site = SITES[TARGET_SITE];
  const host = el('div', { id: 'ext-price-compare-panel' });
  const shadow = host.attachShadow({ mode: 'open' });
  const toggle = el('button', { textContent: '－', title: '折りたたむ' });
  const body = el('div', { className: 'body' });
  const header = el('div', { className: 'header' }, [el('span', { className: 'title', textContent: `${site.label}の価格` })]);
  if (site.isAffiliate()) {
    header.append(el('span', { className: 'pr', textContent: 'PR', title: 'このパネルのリンクはアフィリエイトリンクです' }));
  }
  header.append(toggle);
  const panel = el('div', { className: `panel ${TARGET_SITE}` }, [header, body]);
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '＋' : '－';
    toggle.title = collapsed ? '開く' : '折りたたむ';
  });
  shadow.append(el('style', { textContent: PANEL_CSS }), panel);
  placePanel(host, panel);
  return body;
}

function renderResults({ results, error }, jan) {
  const site = SITES[TARGET_SITE];
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
  const body = createPanel();
  const resultsEl = el('div');

  let currentJan = null;
  const load = async (jan) => {
    currentJan = jan;
    resultsEl.replaceChildren(el('div', { className: 'note', textContent: '読み込み中…' }));
    let result;
    try {
      result = await search(jan);
    } catch (e) {
      result = { error: e.message };
    }
    // 読み込み中に別のバリエーションが選ばれたら古い結果は捨てる
    if (jan === currentJan) resultsEl.replaceChildren(...renderResults(result, jan));
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
    body.append(el('label', { className: 'variant' }, ['バリエーション', select]));
  }
  body.append(resultsEl);
  await load(initial.jan);
}

// JANが見つからず検索できない場合も、価格を出すときと同じ場所に知らせる
function showNotFound() {
  const body = createPanel();
  body.append(el('div', { className: 'note', textContent: 'このページから商品のJANコードを取得できなかったため、価格を検索できませんでした' }));
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
