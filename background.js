const requests = new Map();

// Only forward settings the overlay offers; anything else falls back to the fast default.
function engineSettings(settings) {
  const depth = [8, 12, 16, 20].includes(settings?.depth) ? settings.depth : 8;
  return { depth, multiPv: 5 };
}

// Bot-game play settings mirror the overlay's choices; anything else is not relayed.
const PLAY_ELOS = [1320, 1600, 1900, 2200, 2500];
const PLAY_LOSE_BY = [25, 30, 40, 50];
function playSettings(play) {
  const moveNumber = Number.isInteger(play?.moveNumber) && play.moveNumber >= 1 && play.moveNumber <= 1000 ? play.moveNumber : undefined;
  if (play?.mode === 'elo' && PLAY_ELOS.includes(play.elo)) return { mode: 'elo', elo: play.elo };
  if (play?.mode === 'lose' && PLAY_LOSE_BY.includes(play.loseBy)) return { mode: 'lose', loseBy: play.loseBy, moveNumber };
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cancel-analysis' && sender.tab?.id) {
    const request = requests.get(sender.tab.id);
    if (request && request.requestId === message.requestId) request.controller.abort();
    return false;
  }
  if (message?.type !== 'analyze-position' || !sender.tab?.id) return undefined;
  const tabId = sender.tab.id;
  let url;
  try {
    url = new URL(message.endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/api/analyze/position' || url.search || url.hash) throw new Error('Only the local PawnForge analysis endpoint is allowed.');
  } catch (error) { sendResponse({ error: error.message }); return false; }
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) {
    requests.get(tabId)?.controller.abort();
    const controller = new AbortController();
    const request = { controller, requestId: message.requestId };
    requests.set(tabId, request);
    const timer = setTimeout(() => controller.abort(), 20000);
    const play = message.payload?.play ? playSettings(message.payload.play) : null;
    const localEndpoint = new URL(play ? 'http://127.0.0.1/api/play/move' : 'http://127.0.0.1/api/analyze/position');
    localEndpoint.port = String(Number(url.port || 80));
    const body = play
      ? { fen: message.payload?.fen, ...play }
      : { fen: message.payload?.fen, settings: engineSettings(message.payload?.settings) };
    fetch(localEndpoint, {
      redirect: 'error',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(async (response) => {
      const data = await response.json();
      sendResponse(response.ok ? { data } : { error: data.error || `HTTP ${response.status}` });
    }).catch((error) => sendResponse({ error: error.message })).finally(() => {
      clearTimeout(timer);
      if (requests.get(tabId) === request) requests.delete(tabId);
    });
    return true;
  }
  sendResponse({ error: 'Only the local PawnForge analysis endpoint is allowed.' });
  return false;
});
chrome.tabs.onRemoved.addListener((tabId) => { requests.get(tabId)?.controller.abort(); requests.delete(tabId); });

// Runs in the page's MAIN world, where site objects such as chess.com's board element are visible.
// Injected functions are serialised, so helpers must live inside this function.
function readFenFromPage() {
  const readChessComBoard = () => {
    try {
      const boards = [...document.querySelectorAll('wc-chess-board, chess-board')];
      const area = (element) => { const rect = element.getBoundingClientRect(); return rect.width * rect.height; };
      const board = boards.toSorted((a, b) => area(b) - area(a))[0];
      return typeof board?.game?.getFEN === 'function' ? board.game.getFEN() : null;
    } catch (_error) {
      // The site's board object can throw mid-update; the other sources below still apply.
      return null;
    }
  };
  const values = [
    typeof window.game?.fen === 'function' ? window.game.fen() : null,
    typeof window.chess?.fen === 'function' ? window.chess.fen() : null,
    window.__PAWNFORGE_FEN__,
    readChessComBoard(),
    document.querySelector('input#fenInput, input[name="fen"], input.fen')?.value,
    // lichess analysis board: <div class="pair"><label>FEN</label><input class="copyable" value="...">
    ...[...document.querySelectorAll('.pair input.copyable')].map((input) => input.value)
  ];
  return values.find((value) => typeof value === 'string' && /^[^\s/]+(?:\/[^\s/]+){7} [wb] /.test(value.trim())) || null;
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
  if (!tab.id || !/^https?:\/\/([\w-]+\.)*(chess\.com|lichess\.org|chesstempo\.com|chess\.org)\//.test(tab.url || '')) return;
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
