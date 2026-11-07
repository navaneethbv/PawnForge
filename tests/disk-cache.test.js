import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskCache } from '../disk-cache.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pawnforge-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stored results survive a new cache instance for the same engine build', async (t) => {
  const dir = await tempDir(t);
  const value = { fen: 'x', topMoves: [{ uci: 'e2e4', evalCp: 31 }], bestEvalCp: 31 };
  await new DiskCache(dir, { namespace: 'Stockfish A' }).set('pos:x:12', value);
  assert.deepEqual(await new DiskCache(dir, { namespace: 'Stockfish A' }).get('pos:x:12'), value);
  assert.equal(await new DiskCache(dir, { namespace: 'Stockfish A' }).get('pos:y:12'), undefined);
});

test('a different engine build never reads another build\'s results', async (t) => {
  const dir = await tempDir(t);
  await new DiskCache(dir, { namespace: 'Stockfish A' }).set('pos:x:12', { bestEvalCp: 1 });
  assert.equal(await new DiskCache(dir, { namespace: 'Stockfish B' }).get('pos:x:12'), undefined);
});

test('corrupt entries and a missing directory are misses, not errors', async (t) => {
  const dir = await tempDir(t);
  const cache = new DiskCache(dir, { namespace: 'Stockfish A' });
  await cache.set('pos:x:12', { ok: true });
  await writeFile(cache.path('pos:x:12'), '{"key": "pos:x:12", "value"');
  assert.equal(await cache.get('pos:x:12'), undefined);
  const missing = new DiskCache(join(dir, 'does-not-exist'), { namespace: 'Stockfish A' });
  assert.equal(await missing.get('pos:x:12'), undefined);
  assert.equal(await missing.prune(), 0);
});

test('pruning keeps the newest entries and clears stale temporary files', async (t) => {
  const dir = await tempDir(t);
  const cache = new DiskCache(dir, { namespace: 'Stockfish A', maxEntries: 3 });
  const keys = ['a', 'b', 'c', 'd', 'e'];
  for (const [i, key] of keys.entries()) {
    await cache.set(key, i);
    const when = new Date(Date.now() - (keys.length - i) * 60_000);
    await utimes(cache.path(key), when, when);
  }
  const stale = `${cache.path('a')}.1.1.tmp`;
  await writeFile(stale, 'partial');
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(stale, old, old);

  assert.equal(await cache.prune(), 2);
  assert.deepEqual(await Promise.all(keys.map((key) => cache.get(key))), [undefined, undefined, 2, 3, 4]);
  const shards = await readdir(dir);
  const leftovers = (await Promise.all(shards.map((shard) => readdir(join(dir, shard))))).flat();
  assert.equal(leftovers.filter((name) => name.endsWith('.tmp')).length, 0);
});
