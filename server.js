import { EngineWorker } from './engine-worker.js';
import { DiskCache } from './disk-cache.js';
import {
  ENGINE_ELO_MAX, ENGINE_ELO_MIN, HttpError, START_FEN, chooseLosingMove, clampEval, classify,
  detectOpening, gameAccuracy, mapWithConcurrency, moveAccuracy, parsePgnMoves, parseScore, requireInteger, validateFen
} from './chess-analysis.js';
import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configuredPort = Number(process.env.PORT || 4173);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 4173;
const ROOT = resolve(__dirname);

// Stockfish binary resolution: env var > built-in engine > system paths
function resolveStockfish() {
  const candidateNames = [
    'stockfish',
    'stockfish-macos-universal',
    'stockfish.exe',
    'stockfish-windows-x86-64-avx2.exe',
    'stockfish-windows-x86-64-modern.exe'
  ];
  const candidates = [
    process.env.STOCKFISH_BIN,
    ...candidateNames.flatMap((name) => [
      join(__dirname, 'engine', 'Stockfish', 'src', name),
      join(__dirname, 'engine', 'Stockfish', name)
    ]),
    '/usr/games/stockfish',
    '/usr/local/bin/stockfish',
    '/opt/homebrew/bin/stockfish'
  ];
  // Candidates are operator configuration or fixed install locations, never request input.
  return candidates.find((p) => p && existsSync(p)) ?? 'stockfish';
}

const STOCKFISH_BIN = resolveStockfish();
const ENGINE_CHECK = spawnSync(STOCKFISH_BIN, [], { input: 'uci\nquit\n', encoding: 'utf8', timeout: 5000 });
const ENGINE_AVAILABLE = ENGINE_CHECK.status === 0 && !ENGINE_CHECK.error;
// The UCI handshake names the exact build, e.g. "Stockfish dev-20261028-ff7cee42".
const ENGINE_VERSION = ENGINE_AVAILABLE ? (ENGINE_CHECK.stdout.match(/^id name (.+)$/m)?.[1].trim() ?? null) : null;

const engineDetails = [`available: ${ENGINE_AVAILABLE}`, ENGINE_VERSION].filter(Boolean).join(', ');
console.log(`Stockfish binary: ${STOCKFISH_BIN} (${engineDetails})`);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

// ── LRU Cache ──
class LRUCache {
  constructor(maxSize = 500, ttlMs = 3600000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.delete(key);
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key) {
    return this.get(key) !== undefined;
  }
}

const cache = new LRUCache();

// Engine results also go to disk, so reopening a reviewed game is instant even after a restart.
// PAWNFORGE_CACHE_DIR moves it; set it to "off" to keep results in memory only. Entries are tied to
// the engine build, so updating Stockfish starts a fresh cache.
const cacheDirSetting = process.env.PAWNFORGE_CACHE_DIR ?? join(__dirname, '.cache', 'engine');
const diskCache = ENGINE_VERSION && cacheDirSetting !== 'off'
  ? new DiskCache(resolve(cacheDirSetting), { namespace: ENGINE_VERSION })
  : null;
if (diskCache) void diskCache.prune();

// Returns a cached engine result from memory or disk, or computes and stores it in both.
async function cachedResult(key, compute) {
  if (cache.has(key)) return cache.get(key);
  const stored = await diskCache?.get(key);
  if (stored !== undefined) {
    cache.set(key, stored);
    return stored;
  }
  const value = await compute();
  cache.set(key, value);
  void diskCache?.set(key, value);
  return value;
}

// Transposition table size per engine worker, in MB. Stockfish's default (16) is small for depth 16-20.
const configuredHash = Number(process.env.PAWNFORGE_ENGINE_HASH_MB ?? 64);
const ENGINE_HASH_MB = Number.isInteger(configuredHash) && configuredHash >= 16 && configuredHash <= 2048 ? configuredHash : 64;

// ── Engine Pool ──
class EnginePool {
  constructor(size) {
    this.enabled = ENGINE_AVAILABLE;
    this.size = size;
    const setupCommands = [`setoption name Hash value ${ENGINE_HASH_MB}`];
    this.workers = this.enabled ? Array.from({ length: size }, () => new EngineWorker(STOCKFISH_BIN, { setupCommands })) : [];
    this.pointer = 0;
  }

  acquire() {
    if (!this.enabled || this.workers.length === 0) {
      throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    }
    const ordered = this.workers.slice(this.pointer % this.workers.length).concat(this.workers.slice(0, this.pointer % this.workers.length));
    const w = ordered.reduce((best, worker) => worker.pending < best.pending ? worker : best);
    this.pointer += 1;
    return w;
  }

  // `searchMoves` limits the search to those root moves (UCI "searchmoves"); each still gets its own line.
  // `worker` pins the search to one engine, so consecutive positions reuse its hash (game review).
  async analyzePosition({ fen, depth = 12, multipv = 3, searchMoves = [], worker = null, signal }) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    const key = `pos:${fen}:${depth}:${multipv}:${searchMoves.join(',')}`;
    return cachedResult(key, () => (worker ?? this.acquire()).run(async (w) => {
      w.send(`setoption name MultiPV value ${multipv}`);
      w.send(`position fen ${fen}`);
      w.send(searchMoves.length ? `go depth ${depth} searchmoves ${searchMoves.join(' ')}` : `go depth ${depth}`);

      const lines = [];
      let checkmateScore = null;
      while (true) {
        const line = await w.waitFor(() => true, 8000);
        if (line.startsWith('bestmove')) break;
        if (line.startsWith('info')) {
          if (/ score mate 0\b/.test(line)) {
            checkmateScore = parseScore('mate', 0);
          }
          if (line.includes(' pv ') && line.includes(' multipv ')) {
            lines.push(line);
          }
        }
      }

      const topById = new Map();
      for (const line of lines) {
        const m = line.match(/multipv (\d+).*score (cp|mate) (-?\d+).* pv (.+)$/);
        if (!m) continue;
        const mpv = Number(m[1]);
        topById.set(mpv, { rank: mpv, evalCp: parseScore(m[2], m[3]), pv: m[4], uci: m[4].split(' ')[0] });
      }

      const topMoves = [...topById.values()].sort((a, b) => a.rank - b.rank);
      const bestEvalCp = topMoves.length > 0 ? topMoves[0].evalCp : (checkmateScore ?? 0);
      return { fen, topMoves, bestEvalCp, source: 'stockfish' };
    }, signal));
  }

  // Scores every move in `moves` with one MultiPV search (one line per move), so all scores come from
  // the same search. `onDepth(depth, rows)` fires each time every line has finished a new depth, with
  // the scores so far, so callers can show a ranking long before the search ends.
  async analyzeAllMoves({ fen, moves, depth, signal, onDepth }) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    return cachedResult(`all:${fen}:${depth}`, () => this.acquire().run(async (w) => {
      w.send(`setoption name MultiPV value ${moves.length}`);
      w.send(`position fen ${fen}`);
      w.send(`go depth ${depth} searchmoves ${moves.join(' ')}`);
      const latest = new Map();
      const rowsOf = (scores) => moves.filter((uci) => scores.has(uci)).map((uci) => ({ uci, evalCp: scores.get(uci) }));
      let completedDepth = 0;
      while (true) {
        const line = await w.waitFor(() => true, 8000);
        if (line.startsWith('bestmove')) break;
        const m = line.match(/^info depth (\d+) .*?multipv (\d+) .*?score (cp|mate) (-?\d+)( (?:lower|upper)bound)?.* pv (\S+)/);
        // Bound scores are provisional; keep each move's last exact score.
        if (!m || m[5]) continue;
        latest.set(m[6], parseScore(m[3], m[4]));
        const lineDepth = Number(m[1]);
        if (Number(m[2]) === moves.length && lineDepth > completedDepth) {
          completedDepth = lineDepth;
          onDepth?.(lineDepth, rowsOf(latest));
        }
      }
      return rowsOf(latest);
    }, signal));
  }

  async legalMoves(fen, signal) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    return cachedResult(`moves:${fen}`, () => this.acquire().run(async (w) => {
      w.send(`position fen ${fen}`);
      w.send('go perft 1');
      const out = [];
      while (true) {
        const line = await w.waitFor(() => true, 4000);
        if (line.startsWith('Nodes searched')) break;
        const m = line.match(/^([a-h][1-8][a-h][1-8][qrbn]?):/);
        if (m) out.push(m[1]);
      }
      return out;
    }, signal));
  }

  // Starts every engine and waits for its handshake (process start, network load, hash allocation),
  // so the first real request does not pay for it. Failures are left for that request to report.
  async warmUp() {
    if (!this.enabled) return;
    const started = Date.now();
    await Promise.allSettled(this.workers.map((worker) => worker.run(async () => {})));
    console.log(`Engines ready in ${Date.now() - started}ms`);
  }

  // Rated play is randomised by Stockfish itself, so it is never cached.
  async playAtElo({ fen, elo, movetime = 500, signal }) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    return this.acquire().run(async (w) => {
      w.send('setoption name MultiPV value 1');
      w.send('setoption name UCI_LimitStrength value true');
      w.send(`setoption name UCI_Elo value ${elo}`);
      w.send(`position fen ${fen}`);
      w.send(`go movetime ${movetime}`);
      let evalCp = 0;
      let line = await w.waitFor(() => true, 5000);
      while (!line.startsWith('bestmove')) {
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (m) evalCp = parseScore(m[1], m[2]);
        line = await w.waitFor(() => true, 5000);
      }
      const uci = line.split(' ')[1];
      // Workers are shared with analysis, so restore full strength before releasing this one.
      w.send('setoption name UCI_LimitStrength value false');
      return { uci: uci === '(none)' ? null : uci, evalCp };
    }, signal);
  }
}

const pool = new EnginePool(Math.max(1, Math.min(4, os.cpus().length)));

// ── HTTP Helpers ──
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function sendJson(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME.get('.json'), 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function parseBody(req, signal, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', fail);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const aborted = () => fail(signal.reason);
    const onData = (data) => {
      bytes += data.length;
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'Request body too large'));
        req.resume();
        return;
      }
      raw += data;
    };
    const onEnd = () => {
      cleanup();
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new HttpError(400, 'Request body must be valid JSON.')); }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', fail);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function readJsonObject(req, signal) {
  const body = await parseBody(req, signal);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return body;
}

async function analyzePositionRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const fen = validateFen(body.fen);
  const depth = requireInteger(body.settings?.depth, { name: 'depth', defaultValue: 12, min: 1, max: 20 });
  if (body.settings?.square !== undefined) return sendJson(res, 200, await analyzePieceMoves(fen, body.settings.square, depth, signal));
  const result = await pool.analyzePosition({
    fen,
    signal,
    depth,
    multipv: requireInteger(body.settings?.multiPv, { name: 'multiPv', defaultValue: 3, min: 1, max: 5 })
  });
  return sendJson(res, 200, result);
}

// Scores every legal move of the piece on `square` in one search: one MultiPV line per move.
async function analyzePieceMoves(fen, square, depth, signal) {
  if (typeof square !== 'string' || !/^[a-h][1-8]$/.test(square)) throw new HttpError(400, 'square must be a board square such as e2.');
  const moves = (await pool.legalMoves(fen, signal)).filter((uci) => uci.startsWith(square));
  if (moves.length === 0) return { fen, square, moves: [] };
  const { topMoves } = await pool.analyzePosition({ fen, depth, multipv: moves.length, searchMoves: moves, signal });
  return { fen, square, moves: topMoves.map(({ uci, evalCp, pv }) => ({ uci, evalCp, pv })) };
}

const PLAY_MODES = new Set(['elo', 'full', 'lose']);

async function playMoveRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const fen = validateFen(body.fen);
  const mode = body.mode ?? 'elo';
  if (!PLAY_MODES.has(mode)) throw new HttpError(400, 'mode must be one of elo, full, lose.');

  if (mode === 'elo') {
    const elo = requireInteger(body.elo, { name: 'elo', defaultValue: 1600, min: ENGINE_ELO_MIN, max: ENGINE_ELO_MAX });
    const { uci, evalCp } = await pool.playAtElo({ fen, elo, signal });
    return sendJson(res, 200, { fen, mode, uci, evalCp });
  }

  if (mode === 'full') {
    const { topMoves, bestEvalCp } = await pool.analyzePosition({ fen, depth: 16, multipv: 1, signal });
    return sendJson(res, 200, { fen, mode, uci: topMoves[0]?.uci ?? null, evalCp: bestEvalCp });
  }

  const loseBy = requireInteger(body.loseBy, { name: 'loseBy', defaultValue: 30, min: 20, max: 80 });
  const fullmove = Number(fen.split(' ')[5]) || 1;
  const moveNumber = requireInteger(body.moveNumber, { name: 'moveNumber', defaultValue: fullmove, min: 1, max: 1000 });
  const { topMoves } = await pool.analyzePosition({ fen, depth: 10, multipv: 10, signal });
  const choice = chooseLosingMove(topMoves, { moveNumber, loseBy });
  return sendJson(res, 200, { fen, mode, uci: choice?.uci ?? null, evalCp: choice?.evalCp ?? 0 });
}

// Sorts moves best first and labels each with its loss against the best one.
function rankMoves(rows) {
  const sorted = rows.toSorted((a, b) => b.evalCp - a.evalCp);
  const bestEvalCp = sorted[0]?.evalCp ?? 0;
  return sorted.map((r) => {
    const deltaCp = Math.max(0, clampEval(bestEvalCp) - clampEval(r.evalCp));
    return { ...r, deltaCp, category: classify(deltaCp) };
  });
}

async function analyzeAllMovesRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const fen = validateFen(body.fen);
  const depth = requireInteger(body.settings?.depth, { name: 'depth', defaultValue: 12, min: 4, max: 16 });
  const legal = await pool.legalMoves(fen, signal);

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  // One search scores every legal move from the mover's view; progress streams as each depth completes.
  const rows = legal.length === 0 ? [] : await pool.analyzeAllMoves({
    fen,
    moves: legal,
    depth,
    signal,
    onDepth: (completed, partialRows) => {
      if (res.destroyed) return;
      // Each completed depth carries the full ranking so far, so the page can draw it right away.
      const partial = { type: 'partial', progress: completed / depth, depth: completed, targetDepth: depth, moves: rankMoves(partialRows) };
      res.write(`data: ${JSON.stringify(partial)}\n\n`);
    }
  });
  if (res.destroyed) return undefined;

  const final = rankMoves(rows);
  const bestEvalCp = final[0]?.evalCp ?? 0;

  res.write(`data: ${JSON.stringify({ type: 'final', result: { fen, depth, moves: final, bestEvalCp, legalMoveCount: final.length } })}\n\n`);
  return res.end();
}

// Splits `items` into at most `count` contiguous, nearly equal runs, keeping their order.
function contiguousRuns(items, count) {
  const runs = [];
  const size = Math.ceil(items.length / Math.max(1, count));
  for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
  return runs;
}

function normalizeGameReview(body) {
  const fenSequence = body.fenSequence;
  const preMoveSequence = body.preMoveSequence || [];
  if (!Array.isArray(fenSequence) || fenSequence.length === 0 || fenSequence.length > 500) {
    throw new HttpError(400, 'fenSequence must contain between 1 and 500 FEN positions.');
  }
  if (!Array.isArray(preMoveSequence) || preMoveSequence.length > fenSequence.length) {
    throw new HttpError(400, 'preMoveSequence must be an array no longer than fenSequence.');
  }

  const normalizedFens = fenSequence.map(validateFen);
  const normalizedPreFens = preMoveSequence.map((fen) => fen == null ? null : validateFen(fen));
  const pgn = body.pgn ?? '';
  if (typeof pgn !== 'string') throw new HttpError(400, 'pgn must be a string.');
  const clientMoves = Array.isArray(body.moves)
    && body.moves.length === normalizedFens.length
    && body.moves.every((move) => typeof move === 'string' && move.length <= 16);
  const moves = clientMoves ? body.moves : parsePgnMoves(pgn);
  const depth = requireInteger(body.settings?.depth, { name: 'depth', defaultValue: 10, min: 1, max: 20 });

  return { normalizedFens, normalizedPreFens, moves, depth };
}

// One reviewed ply from the evaluations of the positions before and after it.
function reviewPly(i, { normalizedFens, normalizedPreFens, moves }, evals) {
  const fen = normalizedFens[i];
  const evalAfterMove = evals.get(fen).evalCp;
  const preFen = normalizedPreFens.at(i);
  const before = preFen ? evals.get(preFen) : null;
  // The pre-move eval is from the mover's view and the post-move eval from
  // the opponent's, so their sum is the mover's loss versus the best move.
  const deltaCp = before ? Math.max(0, clampEval(before.evalCp) + clampEval(evalAfterMove)) : 0;
  return {
    ply: i + 1,
    san: moves.at(i) || `ply-${i + 1}`,
    fen,
    mover: preFen ? preFen.split(' ')[1] : null,
    evalCp: evalAfterMove,
    deltaCp,
    accuracy: before ? Math.round(moveAccuracy(before.evalCp, -evalAfterMove) * 10) / 10 : null,
    category: classify(deltaCp),
    // The engine's choice in the position before this move, for "what was better" and puzzles.
    bestMove: before?.best ? { uci: before.best.uci, evalCp: before.best.evalCp, pv: before.best.pv.split(' ').slice(0, 8) } : null
  };
}

// Reviews a game. `onPly(ply)` fires as soon as both positions around a move are analysed, which is
// out of order because the engines work on different stretches of the game at once.
async function reviewGame(review, signal, onPly) {
  const { normalizedFens, normalizedPreFens, moves, depth } = review;
  // Each pre-move position is usually the previous post-move position, so analyze every distinct FEN
  // once. The positions are split into contiguous runs in game order, one run per engine, so each
  // engine searches neighbouring positions and reuses its hash from the previous one.
  const uniqueFens = [...new Set([...normalizedPreFens.filter(Boolean), ...normalizedFens])];
  const runs = contiguousRuns(uniqueFens, pool.size);
  const evals = new Map();
  const plies = new Array(normalizedFens.length).fill(null);
  // Which plies each position completes: the move that reached it and the move played from it.
  const pliesByFen = new Map();
  const track = (fen, index) => { if (fen) pliesByFen.set(fen, [...(pliesByFen.get(fen) ?? []), index]); };
  normalizedFens.forEach((fen, i) => { track(fen, i); track(normalizedPreFens.at(i), i); });

  await mapWithConcurrency(runs, runs.length, async (run, runIndex) => {
    for (const fen of run) {
      signal.throwIfAborted();
      const analysis = await pool.analyzePosition({ fen, depth, multipv: 1, worker: pool.workers[runIndex], signal });
      evals.set(fen, { evalCp: analysis.bestEvalCp, best: analysis.topMoves[0] ?? null });
      for (const i of pliesByFen.get(fen) ?? []) {
        const preFen = normalizedPreFens.at(i);
        if (plies[i] || !evals.has(normalizedFens[i]) || (preFen && !evals.has(preFen))) continue;
        plies[i] = reviewPly(i, review, evals);
        onPly?.(plies[i]);
      }
    }
  });

  const sideAccuracies = { w: [], b: [] };
  for (const p of plies) if (p.accuracy !== null) sideAccuracies[p.mover].push(p.accuracy);
  return {
    opening: detectOpening(moves, { startFen: normalizedPreFens[0] || START_FEN }),
    accuracy: { white: gameAccuracy(sideAccuracies.w), black: gameAccuracy(sideAccuracies.b) },
    plyCount: plies.length,
    plies,
    turningPoints: plies.filter((p) => p.deltaCp >= 150),
    evalGraph: plies.map((p) => ({ ply: p.ply, evalCp: p.evalCp }))
  };
}

// Returns the whole review as JSON, or with `"stream": true` as server-sent events: one `ply` event
// per move as it is ready, then a `final` event with the complete review.
async function analyzeGameRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const review = normalizeGameReview(body);
  if (body.stream !== true) return sendJson(res, 200, await reviewGame(review, signal));

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const send = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  send({ type: 'start', plyCount: review.normalizedFens.length });
  const result = await reviewGame(review, signal, (ply) => send({ type: 'ply', ply }));
  send({ type: 'final', result });
  return res.end();
}

async function dispatchApi(req, res, signal) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/analyze/position') return analyzePositionRequest(req, res, signal);
  // Server-sent events stream
  if (route === 'POST /api/analyze/all-moves') return analyzeAllMovesRequest(req, res, signal);
  if (route === 'POST /api/analyze/game') return analyzeGameRequest(req, res, signal);
  if (route === 'POST /api/play/move') return playMoveRequest(req, res, signal);

  if (route === 'GET /api/opening') {
    const moves = (url.searchParams.get('moves') || '').split(' ').filter(Boolean);
    if (moves.length > 500) throw new HttpError(400, 'Too many moves.');
    const fen = url.searchParams.get('fen');
    return sendJson(res, 200, detectOpening(moves, { startFen: fen ? validateFen(fen) : START_FEN }));
  }

  if (route === 'GET /api/status') {
    return sendJson(res, 200, {
      engine: pool.enabled ? 'stockfish' : 'unavailable',
      engineVersion: ENGINE_VERSION,
      engineHashMb: ENGINE_HASH_MB,
      workers: pool.size,
      cacheSize: cache.cache.size,
      diskCache: diskCache ? diskCache.dir : null,
      uptime: process.uptime()
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ── API Handler ──
async function handleApi(req, res) {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new Error('Request cancelled'));
  res.on('close', cancel);
  const deadline = setTimeout(() => controller.abort(new Error('Request deadline exceeded')), 120000);
  const origin = req.headers.origin;
  const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  const allowed = !origin || allowedOrigins.has(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (!allowed) {
    clearTimeout(deadline);
    return sendJson(res, 403, { error: 'Origin not allowed.' });
  }
  if (req.method === 'OPTIONS') {
    clearTimeout(deadline);
    res.writeHead(204);
    return res.end();
  }

  try {
    return await dispatchApi(req, res, signal);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      return res.end();
    }
    const status = error.statusCode || 500;
    if (status >= 500) console.error('API error:', error.message);
    return sendJson(res, status, { error: error.message || 'Request failed.' });
  } finally {
    clearTimeout(deadline);
    res.removeListener('close', cancel);
  }
}

const publicFiles = new Map([
  ['/index.html', join(ROOT, 'index.html')],
  ['/overlay.js', join(ROOT, 'overlay.js')],
  ['/src/main.js', join(ROOT, 'src', 'main.js')],
  ['/src/styles.css', join(ROOT, 'src', 'styles.css')],
  ['/src/game-import.js', join(ROOT, 'src', 'game-import.js')],
  ['/src/chess-position.js', join(ROOT, 'src', 'chess-position.js')],
  // Pinned frontend libraries, served locally so the app works offline.
  ['/vendor/chess.js', join(ROOT, 'vendor', 'chess.js')],
  ['/vendor/jquery.min.js', join(ROOT, 'vendor', 'jquery.min.js')],
  ['/vendor/chessboard-1.0.0.min.js', join(ROOT, 'vendor', 'chessboard-1.0.0.min.js')],
  ['/vendor/chessboard-1.0.0.min.css', join(ROOT, 'vendor', 'chessboard-1.0.0.min.css')]
]);

// ── Static File Server ──
function serveStatic(req, res) {
  const pathname = req.url.split('?')[0];
  const reqPath = pathname === '/' ? '/index.html' : pathname;

  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch (_err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: Invalid URL encoding');
    return;
  }

  if (decoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const filePath = publicFiles.get(decoded);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  // filePath comes from the publicFiles allowlist, not from the request path.
  const stream = createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME.get(ext) || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    stream.pipe(res);
  });

  stream.on('error', (err) => {
    console.error('Error serving %s: %s', reqPath.replace(/[\r\n]/g, ''), err.message);
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Not found');
  });
}

// ── Server ──
const server = http.createServer((req, res) => {
  const host = req.headers.host;
  if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(host)) return sendJson(res, 403, { error: 'Host not allowed.' });
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`PawnForge running at http://localhost:${PORT} | stockfish=${pool.enabled ? 'on' : 'off'} | workers=${pool.size} | hash=${ENGINE_HASH_MB}MB | disk cache=${diskCache ? diskCache.dir : 'off'}`);
  void pool.warmUp();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    for (const worker of pool.workers) worker.stop();
    server.close();
    server.closeAllConnections();
  });
}
