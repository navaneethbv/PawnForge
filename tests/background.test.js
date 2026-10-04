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
