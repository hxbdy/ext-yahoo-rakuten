importScripts('sites.js');

// content script からは相手サイトの検索ページを直接取得できない (CORS) ので、ここで取得してHTMLを返す。
// 取得先は SITES の検索URLに限る。
async function fetchSearch(site, jan) {
  if (!SITES[site] || !/^(\d{8}|\d{13})$/.test(jan)) return { error: '不正なリクエストです' };

  let res;
  try {
    res = await fetch(SITES[site].searchUrl(jan), { credentials: 'omit' });
  } catch (e) {
    return { error: `通信エラー: ${e.message}` };
  }
  if (!res.ok) return { error: `${SITES[site].label}の検索ページを取得できませんでした (HTTP ${res.status})` };
  return { html: await res.text() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'fetchSearch') {
    fetchSearch(message.site, message.jan)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // 非同期で sendResponse する
  }
});
