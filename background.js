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
