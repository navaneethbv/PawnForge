const requests = new Map();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'analyze-position' || !sender.tab?.id) return undefined;
  const tabId = sender.tab.id;
  let url;
  try {
    url = new URL(message.endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/api/analyze/position' || url.search || url.hash) throw new Error('Only the local PawnForge analysis endpoint is allowed.');
  } catch (error) { sendResponse({ error: error.message }); return false; }
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) {
    requests.get(tabId)?.abort();
    const controller = new AbortController();
    requests.set(tabId, controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    const localEndpoint = new URL('http://127.0.0.1/api/analyze/position');
    localEndpoint.port = String(Number(url.port || 80));
    fetch(localEndpoint, {
      redirect: 'error',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: message.payload?.fen, settings: { depth: 8, multiPv: 3 } }),
      signal: controller.signal
    }).then(async (response) => {
      const data = await response.json();
      sendResponse(response.ok ? { data } : { error: data.error || `HTTP ${response.status}` });
    }).catch((error) => sendResponse({ error: error.message })).finally(() => {
      clearTimeout(timer);
      if (requests.get(tabId) === controller) requests.delete(tabId);
    });
    return true;
  }
  sendResponse({ error: 'Only the local PawnForge analysis endpoint is allowed.' });
  return false;
});
chrome.tabs.onRemoved.addListener((tabId) => { requests.get(tabId)?.abort(); requests.delete(tabId); });

function readFenFromPage() {
  const values = [
    typeof window.game?.fen === 'function' ? window.game.fen() : null,
    typeof window.chess?.fen === 'function' ? window.chess.fen() : null,
    window.__PAWNFORGE_FEN__,
    document.querySelector('input#fenInput, input[name="fen"], input.fen')?.value
  ];
  return values.find((value) => typeof value === 'string' && value.includes('/')) || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'read-page-fen' || !sender.tab?.id) return undefined;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id },
    world: 'MAIN',
    func: readFenFromPage
  }).then((results) => {
    sendResponse({ fen: results?.[0]?.result || null });
  }).catch(() => {
    sendResponse({ fen: null });
  });
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-overlay' });
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-overlay' });
    } catch (_injectionError) {
      // Chrome pages that disallow content scripts are handled by the HUD hint.
    }
  }
});
