import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('relay cancellation affects only the matching search in the sending tab', async () => {
  const listeners = [];
  const signals = [];
  let tabRemoved;
  const chrome = {
    runtime: { onMessage: { addListener: listener => listeners.push(listener) } },
    tabs: { onRemoved: { addListener: listener => { tabRemoved = listener; } } },
    action: { onClicked: { addListener: () => {} } }
  };
  vm.runInNewContext(await readFile('background.js', 'utf8'), {
    chrome, URL, AbortController, setTimeout, clearTimeout,
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    })
  });
  const send = (type, requestId, tabId = 1) => new Promise(resolve => {
    const result = listeners[0]({ type, requestId, endpoint: 'http://127.0.0.1:4189/api/analyze/position' }, { tab: { id: tabId } }, resolve);
    if (result !== true) resolve();
  });
  const first = send('analyze-position', 'first');
  const next = send('analyze-position', 'next');
  assert.equal(signals[0].aborted, true);
  await send('cancel-analysis', 'first');
  await send('cancel-analysis', 'next', 2);
  assert.equal(signals[1].aborted, false);
  await send('cancel-analysis', 'next');
  assert.equal(signals[1].aborted, true);
  await Promise.all([first, next]);
  const last = send('analyze-position', 'last');
  tabRemoved(1);
  assert.equal(signals[2].aborted, true);
  await last;
});

test('bot-game play requests go to the play endpoint with only the offered settings', async () => {
  const listeners = [];
  const calls = [];
  const chrome = {
    runtime: { onMessage: { addListener: listener => listeners.push(listener) } },
    tabs: { onRemoved: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } }
  };
  vm.runInNewContext(await readFile('background.js', 'utf8'), {
    chrome, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    }
  });
  const send = (payload, tabId) => new Promise(resolve => {
    listeners[0]({ type: 'analyze-position', requestId: String(tabId), endpoint: 'http://127.0.0.1:4189/api/analyze/position', payload }, { tab: { id: tabId } }, resolve);
  });
  const fen = '8/8/8/8/8/8/8/K6k w - - 0 1';
  await send({ fen, play: { mode: 'lose', loseBy: 30, moveNumber: 12, extra: 'x' } }, 1);
  await send({ fen, play: { mode: 'elo', elo: 1900 } }, 2);
  await send({ fen, play: { mode: 'elo', elo: 3190 }, settings: { depth: 12 } }, 3);
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:4189/api/play/move', body: { fen, mode: 'lose', loseBy: 30, moveNumber: 12 } });
  assert.deepEqual(calls[1], { url: 'http://127.0.0.1:4189/api/play/move', body: { fen, mode: 'elo', elo: 1900 } });
  // Settings the overlay does not offer fall back to normal analysis.
  assert.deepEqual(calls[2], { url: 'http://127.0.0.1:4189/api/analyze/position', body: { fen, settings: { depth: 12, multiPv: 5 } } });
});
