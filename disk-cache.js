import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { mapWithConcurrency } from './chess-analysis.js';

// Engine results kept on disk so they survive restarts. Each entry is one small JSON file named by a
// hash of the engine version and the request, so a different Stockfish build never reads another
// build's results. Writes go to a temporary file and are renamed into place, so a crash cannot
// leave a half-written entry. Every operation is best effort: a missing or broken cache is a miss.
export class DiskCache {
  constructor(dir, { namespace, maxEntries = 20000 }) {
    this.dir = dir;
    this.namespace = namespace;
    this.maxEntries = maxEntries;
    this.writes = 0;
  }

  path(key) {
    const name = createHash('sha256').update(`${this.namespace}\n${key}`).digest('hex');
    // Two-character shards keep any one directory small.
    return join(this.dir, name.slice(0, 2), `${name}.json`);
  }

  async get(key) {
    try {
      const entry = JSON.parse(await readFile(this.path(key), 'utf8'));
      // The stored key guards against the (astronomically unlikely) hash collision.
      return entry?.key === key ? entry.value : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key, value) {
    const file = this.path(key);
    this.writes += 1;
    const temp = `${file}.${process.pid}.${this.writes}.tmp`;
    try {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(temp, JSON.stringify({ key, value }));
      await rename(temp, file);
    } catch {
      await rm(temp, { force: true }).catch(() => {});
    }
    // Pruning walks the whole cache, so do it only now and then.
    if (this.writes % 500 === 0) void this.prune();
  }

  // Removes the oldest entries (and stale temporary files) once the cache holds more than maxEntries.
  async prune() {
    try {
      const files = [];
      await mapWithConcurrency(await readdir(this.dir), 4, async (shard) => {
        const shardDir = join(this.dir, shard);
        const names = await readdir(shardDir).catch(() => []);
        await mapWithConcurrency(names, 16, async (name) => {
          const file = join(shardDir, name);
          const info = await stat(file).catch(() => null);
          if (!info) return;
          if (name.endsWith('.tmp') && Date.now() - info.mtimeMs > 60_000) await rm(file, { force: true });
          else if (name.endsWith('.json')) files.push({ file, mtime: info.mtimeMs });
        });
      });
      if (files.length <= this.maxEntries) return 0;
      files.sort((a, b) => a.mtime - b.mtime);
      const excess = files.slice(0, files.length - this.maxEntries);
      await Promise.all(excess.map(({ file }) => rm(file, { force: true })));
      return excess.length;
    } catch {
      return 0;
    }
  }
}
