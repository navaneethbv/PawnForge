import { EngineWorker } from './engine-worker.js';
import {
  HttpError, MATE_THRESHOLD, START_FEN, clampEval, classify, detectOpening, mapWithConcurrency,
  parsePgnMoves, parseScore, requireInteger, validateFen
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
  if (process.env.STOCKFISH_BIN && existsSync(process.env.STOCKFISH_BIN)) {
    return process.env.STOCKFISH_BIN;
  }
  const candidateNames = [
    'stockfish',
    'stockfish-macos-universal',
    'stockfish.exe',
    'stockfish-windows-x86-64-avx2.exe',
    'stockfish-windows-x86-64-modern.exe'
  ];
  for (const name of candidateNames) {
    const p = join(__dirname, 'engine', 'Stockfish', 'src', name);
    if (existsSync(p)) return p;
    const pRoot = join(__dirname, 'engine', 'Stockfish', name);
    if (existsSync(pRoot)) return pRoot;
  }
  if (existsSync('/usr/games/stockfish')) return '/usr/games/stockfish';
  if (existsSync('/usr/local/bin/stockfish')) return '/usr/local/bin/stockfish';
  if (existsSync('/opt/homebrew/bin/stockfish')) return '/opt/homebrew/bin/stockfish';
  return 'stockfish';
}

const STOCKFISH_BIN = resolveStockfish();
const ENGINE_CHECK = spawnSync(STOCKFISH_BIN, ['-h'], { stdio: 'ignore', timeout: 5000 });
const ENGINE_AVAILABLE = ENGINE_CHECK.status === 0 && !ENGINE_CHECK.error;

console.log(`Stockfish binary: ${STOCKFISH_BIN} (available: ${ENGINE_AVAILABLE})`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

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

// ── Engine Pool ──
class EnginePool {
  constructor(size) {
    this.enabled = ENGINE_AVAILABLE;
    this.size = size;
    this.workers = this.enabled ? Array.from({ length: size }, () => new EngineWorker(STOCKFISH_BIN)) : [];
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

  async analyzePosition({ fen, depth = 12, multipv = 3, signal }) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    const key = `pos:${fen}:${depth}:${multipv}`;
    if (cache.has(key)) return cache.get(key);

    const result = await this.acquire().run(async (w) => {
      w.send(`setoption name MultiPV value ${multipv}`);
      w.send(`position fen ${fen}`);
      w.send(`go depth ${depth}`);

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
    }, signal);

    cache.set(key, result);
    return result;
  }

  async legalMoves(fen, signal) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    const key = `moves:${fen}`;
    if (cache.has(key)) return cache.get(key);
    const moves = await this.acquire().run(async (w) => {
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
    }, signal);
    cache.set(key, moves);
    return moves;
  }

  async evaluateMove(fen, move, movetime = 120, signal) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    return this.acquire().run(async (w) => {
      w.send('setoption name MultiPV value 1');
      w.send(`position fen ${fen} moves ${move}`);
      w.send(`go movetime ${movetime}`);
      let score = 0;
      while (true) {
        const line = await w.waitFor(() => true, 5000);
        if (line.startsWith('bestmove')) break;
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (m) score = parseScore(m[1], m[2]);
      }
      return score;
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
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
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
  const result = await pool.analyzePosition({
    fen,
    signal,
    depth: requireInteger(body.settings?.depth, { name: 'depth', defaultValue: 12, min: 1, max: 20 }),
    multipv: requireInteger(body.settings?.multiPv, { name: 'multiPv', defaultValue: 3, min: 1, max: 5 })
  });
  return sendJson(res, 200, result);
}

async function analyzeAllMovesRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const fen = validateFen(body.fen);

  const movetime = requireInteger(body.settings?.movetimeMs, {
    name: 'movetimeMs',
    defaultValue: 120,
    min: 20,
    max: 1000
  });
  const legal = await pool.legalMoves(fen, signal);

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  let clientDisconnected = false;
  res.on('close', () => { clientDisconnected = true; });

  const rows = [];
  for (let i = 0; i < legal.length; i += 1) {
    if (clientDisconnected) return;
    const move = legal[i];
    // The engine scores the reply position for the opponent. Negate it for the
    // mover, and count the move itself when the mover is delivering mate.
    const moverEval = -(await pool.evaluateMove(fen, move, movetime, signal));
    const row = { uci: move, evalCp: moverEval >= MATE_THRESHOLD ? moverEval - 1 : moverEval };
    rows.push(row);
    res.write(`data: ${JSON.stringify({ type: 'partial', progress: (i + 1) / legal.length, row })}\n\n`);
  }

  rows.sort((a, b) => b.evalCp - a.evalCp);
  const bestEvalCp = rows[0]?.evalCp ?? 0;
  const final = rows.map((r) => {
    const deltaCp = Math.max(0, clampEval(bestEvalCp) - clampEval(r.evalCp));
    return { ...r, deltaCp, category: classify(deltaCp) };
  });

  res.write(`data: ${JSON.stringify({ type: 'final', result: { fen, moves: final, bestEvalCp, legalMoveCount: final.length } })}\n\n`);
  return res.end();
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

async function analyzeGameRequest(req, res, signal) {
  if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
  const body = await readJsonObject(req, signal);
  const { normalizedFens, normalizedPreFens, moves, depth } = normalizeGameReview(body);

  // Each pre-move position is usually the previous post-move position, so
  // analyze every distinct FEN once, spread across the engine pool.
  const uniqueFens = [...new Set([...normalizedPreFens.filter(Boolean), ...normalizedFens])];
  const evals = new Map();
  await mapWithConcurrency(uniqueFens, pool.size, async (fen) => {
    signal.throwIfAborted();
    const analysis = await pool.analyzePosition({ fen, depth, multipv: 1, signal });
    evals.set(fen, analysis.bestEvalCp);
  });

  const plies = normalizedFens.map((fen, i) => {
    const evalAfterMove = evals.get(fen);
    const preFen = normalizedPreFens[i];
    // The pre-move eval is from the mover's view and the post-move eval from
    // the opponent's, so their sum is the mover's loss versus the best move.
    const deltaCp = preFen ? Math.max(0, clampEval(evals.get(preFen)) + clampEval(evalAfterMove)) : 0;
    return {
      ply: i + 1,
      san: moves[i] || `ply-${i + 1}`,
      fen,
      evalCp: evalAfterMove,
      deltaCp,
      category: classify(deltaCp)
    };
  });

  const turningPoints = plies.filter((p) => p.deltaCp >= 150);
  const evalGraph = plies.map((p) => ({ ply: p.ply, evalCp: p.evalCp }));
  return sendJson(res, 200, {
    opening: detectOpening(moves, { startFen: normalizedPreFens[0] || START_FEN }),
    plyCount: plies.length,
    plies,
    turningPoints,
    evalGraph
  });
}

async function dispatchApi(req, res, signal) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/analyze/position') return analyzePositionRequest(req, res, signal);
  // Server-sent events stream
  if (route === 'POST /api/analyze/all-moves') return analyzeAllMovesRequest(req, res, signal);
  if (route === 'POST /api/analyze/game') return analyzeGameRequest(req, res, signal);

  if (route === 'GET /api/opening') {
    const moves = (url.searchParams.get('moves') || '').split(' ').filter(Boolean);
    if (moves.length > 500) throw new HttpError(400, 'Too many moves.');
    const fen = url.searchParams.get('fen');
    return sendJson(res, 200, detectOpening(moves, { startFen: fen ? validateFen(fen) : START_FEN }));
  }

  if (route === 'GET /api/status') {
    return sendJson(res, 200, {
      engine: pool.enabled ? 'stockfish' : 'unavailable',
      workers: pool.size,
      cacheSize: cache.cache.size,
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
  ['/src/styles.css', join(ROOT, 'src', 'styles.css')]
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
  const stream = createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
  console.log(`PawnForge running at http://localhost:${PORT} | stockfish=${pool.enabled ? 'on' : 'off'} | workers=${pool.size}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    for (const worker of pool.workers) worker.stop();
    server.close();
    server.closeAllConnections();
  });
}
