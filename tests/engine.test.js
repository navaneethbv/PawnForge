import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineWorker } from '../engine-worker.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pawnforge-uci-'));
  const binary = join(dir, 'engine');
  await writeFile(binary, `#!${process.execPath}\n` + `
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  if (line === 'uci') console.log('uciok');
  if (line === 'isready') console.log('readyok');
  if (line === 'crash') process.exit(1);
  if (line === 'flood') setInterval(() => console.log('info depth 1'), 10);
  if (line === 'probe') console.log('bestmove e2e4');
});`, { mode: 0o700 });
  const worker = new EngineWorker(binary, { timeoutMs: 2000, ...options });
  t.after(async () => { worker.stop(); await rm(dir, { recursive: true, force: true }); });
  return worker;
}
const probe = (worker) => worker.run(async (w) => { w.send('probe'); return w.waitFor(line => line.startsWith('bestmove')); });

test('respawns after a process exits during a job', async t => {
  const worker = await fixture(t);
  await assert.rejects(worker.run(async w => { w.send('crash'); await w.waitFor(() => true); }), /exited/);
  assert.equal(await probe(worker), 'bestmove e2e4');
});
test('enforces an overall deadline despite continuous engine output', async t => {
  const worker = await fixture(t);
  await assert.rejects(worker.run(async w => { w.send('flood'); while (true) await w.waitFor(() => true); }), /deadline/);
  assert.equal(await probe(worker), 'bestmove e2e4');
});
test('cancels running work, skips queued work, and recovers', async t => {
  const worker = await fixture(t);
  const running = new AbortController();
  const queued = new AbortController();
  const job = worker.run(async w => { w.send('flood'); while (true) await w.waitFor(() => true); }, running.signal);
  let executed = false;
  const waiting = worker.run(() => { executed = true; }, queued.signal);
  queued.abort(new Error('queued cancelled'));
  setTimeout(() => running.abort(new Error('running cancelled')), 150);
  await assert.rejects(job, /running cancelled/);
  await assert.rejects(waiting, /queued cancelled/);
  assert.equal(executed, false);
  assert.equal(await probe(worker), 'bestmove e2e4');
});
test('rejects overload without growing the queue', async t => {
  const worker = await fixture(t, { maxPending: 1 });
  const first = probe(worker);
  await assert.rejects(probe(worker), { statusCode: 429 });
  await first;
  assert.equal(worker.pending, 0);
});
