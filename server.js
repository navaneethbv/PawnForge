import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 4173);
const ROOT = resolve(process.cwd());

// Stockfish binary resolution: env var > built-in engine > system paths
function resolveStockfish() {
  if (process.env.STOCKFISH_BIN && existsSync(process.env.STOCKFISH_BIN)) {
    return process.env.STOCKFISH_BIN;
  }
  const builtIn = join(__dirname, 'engine', 'Stockfish', 'src', 'stockfish');
  if (existsSync(builtIn)) return builtIn;
  if (existsSync('/usr/games/stockfish')) return '/usr/games/stockfish';
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

// ── Opening Book (expanded) ──
const openingBook = [
  // Open games (1.e4 e5)
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], eco: 'C60', name: 'Ruy Lopez' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], eco: 'C68', name: 'Ruy Lopez, Exchange Variation' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], eco: 'C50', name: 'Italian Game' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], eco: 'C50', name: 'Giuoco Piano' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], eco: 'C55', name: 'Two Knights Defense' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'], eco: 'C44', name: 'Scotch Game' },
  { line: ['e4', 'e5', 'Nf3', 'Nf6'], eco: 'C42', name: 'Petrov Defense' },
  { line: ['e4', 'e5', 'Nf3', 'd6'], eco: 'C41', name: 'Philidor Defense' },
  { line: ['e4', 'e5', 'f4'], eco: 'C30', name: "King's Gambit" },
  { line: ['e4', 'e5', 'Nc3'], eco: 'C25', name: 'Vienna Game' },
  { line: ['e4', 'e5', 'd4'], eco: 'C21', name: 'Center Game' },

  // Sicilian Defense
  { line: ['e4', 'c5'], eco: 'B20', name: 'Sicilian Defence' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3'], eco: 'B90', name: 'Sicilian Najdorf' },
  { line: ['e4', 'c5', 'Nf3', 'Nc6'], eco: 'B30', name: 'Sicilian, Old Sicilian' },
  { line: ['e4', 'c5', 'Nf3', 'e6'], eco: 'B40', name: 'Sicilian, French Variation' },
  { line: ['e4', 'c5', 'c3'], eco: 'B22', name: 'Sicilian Alapin' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], eco: 'B90', name: 'Sicilian Najdorf' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'], eco: 'B76', name: 'Sicilian Dragon' },

  // French Defense
  { line: ['e4', 'e6'], eco: 'C00', name: 'French Defence' },
  { line: ['e4', 'e6', 'd4', 'd5'], eco: 'C00', name: 'French Defence' },
  { line: ['e4', 'e6', 'd4', 'd5', 'Nc3'], eco: 'C03', name: 'French Tarrasch' },
  { line: ['e4', 'e6', 'd4', 'd5', 'e5'], eco: 'C02', name: 'French Advance' },
  { line: ['e4', 'e6', 'd4', 'd5', 'exd5'], eco: 'C01', name: 'French Exchange' },

  // Caro-Kann
  { line: ['e4', 'c6'], eco: 'B10', name: 'Caro-Kann Defence' },
  { line: ['e4', 'c6', 'd4', 'd5'], eco: 'B12', name: 'Caro-Kann Defence' },
  { line: ['e4', 'c6', 'd4', 'd5', 'Nc3'], eco: 'B15', name: 'Caro-Kann, Main Line' },
  { line: ['e4', 'c6', 'd4', 'd5', 'e5'], eco: 'B12', name: 'Caro-Kann Advance' },

  // Scandinavian
  { line: ['e4', 'd5'], eco: 'B01', name: 'Scandinavian Defense' },
  { line: ['e4', 'd5', 'exd5', 'Qxd5'], eco: 'B01', name: 'Scandinavian Defense, Mieses-Kotroc' },

  // Pirc/Modern
  { line: ['e4', 'd6'], eco: 'B07', name: 'Pirc Defense' },
  { line: ['e4', 'g6'], eco: 'B06', name: 'Modern Defense' },

  // Alekhine
  { line: ['e4', 'Nf6'], eco: 'B02', name: "Alekhine's Defense" },

  // Queen's Gambit
  { line: ['d4', 'd5', 'c4'], eco: 'D06', name: "Queen's Gambit" },
  { line: ['d4', 'd5', 'c4', 'e6'], eco: 'D30', name: "Queen's Gambit Declined" },
  { line: ['d4', 'd5', 'c4', 'dxc4'], eco: 'D20', name: "Queen's Gambit Accepted" },
  { line: ['d4', 'd5', 'c4', 'c6'], eco: 'D10', name: 'Slav Defense' },
  { line: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'], eco: 'D53', name: "QGD, Classical" },
  { line: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Nf3'], eco: 'D37', name: "QGD, 3 Knights" },

  // Indian Defenses
  { line: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4'], eco: 'E70', name: "King's Indian Defence" },
  { line: ['d4', 'Nf6', 'c4', 'g6'], eco: 'E60', name: "King's Indian Defence" },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'], eco: 'E20', name: 'Nimzo-Indian Defence' },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'], eco: 'E10', name: 'Queen\'s Indian Defence' },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'g3'], eco: 'E00', name: 'Catalan Opening' },
  { line: ['d4', 'Nf6', 'c4', 'c5'], eco: 'A50', name: 'Benoni Defense' },
  { line: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6'], eco: 'A60', name: 'Modern Benoni' },

  // English
  { line: ['c4'], eco: 'A10', name: 'English Opening' },
  { line: ['c4', 'e5'], eco: 'A20', name: 'English, Reversed Sicilian' },
  { line: ['c4', 'Nf6'], eco: 'A15', name: 'English, Anglo-Indian' },
  { line: ['c4', 'c5'], eco: 'A30', name: 'English, Symmetrical' },

  // Reti
  { line: ['Nf3', 'd5', 'c4'], eco: 'A09', name: 'Reti Opening' },
  { line: ['Nf3'], eco: 'A04', name: 'Reti Opening' },

  // London/Trompowsky
  { line: ['d4', 'Nf6', 'Bf4'], eco: 'D00', name: 'London System' },
  { line: ['d4', 'd5', 'Bf4'], eco: 'D00', name: 'London System' },
  { line: ['d4', 'Nf6', 'Bg5'], eco: 'A45', name: 'Trompowsky Attack' },

  // Dutch
  { line: ['d4', 'f5'], eco: 'A80', name: 'Dutch Defense' },

  // Grunfeld
  { line: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'], eco: 'D80', name: 'Grunfeld Defense' },

  // Bird
  { line: ['f4'], eco: 'A02', name: "Bird's Opening" },

  // Other d4 lines
  { line: ['d4', 'd5'], eco: 'D00', name: "Queen's Pawn Game" },
  { line: ['d4', 'Nf6'], eco: 'A46', name: "Indian Game" },
];

function classify(deltaCp) {
  if (deltaCp <= 20) return { key: 'best', label: 'Best', color: 'blue' };
  if (deltaCp <= 60) return { key: 'good', label: 'Good', color: 'green' };
  if (deltaCp <= 150) return { key: 'inaccuracy', label: 'Inaccuracy', color: 'orange' };
  if (deltaCp <= 300) return { key: 'mistake', label: 'Mistake', color: 'red' };
  return { key: 'blunder', label: 'Blunder', color: 'red-strong' };
}

function parsePgnMoves(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function detectOpening(moveList) {
  // Sort by longest matching line first for most specific match
  let bestMatch = null;
  let bestLength = 0;

  for (const item of openingBook) {
    if (item.line.every((m, i) => moveList[i] === m) && item.line.length > bestLength) {
      bestMatch = item;
      bestLength = item.line.length;
    }
  }

  if (bestMatch) {
    // Find continuations from current position
    const continuations = findContinuations(moveList);
    return {
      eco: bestMatch.eco,
      name: bestMatch.name,
      bookPlyRange: [1, bestMatch.line.length],
      continuations
    };
  }

  return {
    eco: 'A00',
    name: 'Uncommon Opening',
    bookPlyRange: [1, Math.min(8, moveList.length || 8)],
    continuations: findContinuations(moveList)
  };
}

function findContinuations(moveList) {
  const continuations = [];
  const seen = new Set();

  for (const item of openingBook) {
    // Check if current moves are a prefix of this opening line
    if (item.line.length > moveList.length &&
        moveList.every((m, i) => item.line[i] === m)) {
      const nextMove = item.line[moveList.length];
      if (!seen.has(nextMove)) {
        seen.add(nextMove);
        continuations.push({
          move: nextMove,
          name: item.name,
          eco: item.eco
        });
      }
    }
  }

  return continuations;
}

// ── Engine Worker ──
class EngineWorker {
  constructor() {
    this.proc = spawn(STOCKFISH_BIN);
    this.queue = Promise.resolve();
    this.ready = false;
    this.lines = [];
    this.waiters = [];

    this.proc.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        const l = line.trim();
        if (!l) continue;
        this.lines.push(l);
        const pending = [...this.waiters];
        this.waiters = [];
        pending.forEach((r) => r());
      }
    });

    this.proc.stderr.on('data', () => {});

    this.send('uci');
    this.send('isready');
  }

  send(cmd) {
    this.proc.stdin.write(`${cmd}\n`);
  }

  async waitFor(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const idx = this.lines.findIndex(predicate);
      if (idx !== -1) {
        const matched = this.lines[idx];
        this.lines = this.lines.slice(idx + 1);
        return matched;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Engine timeout');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(new Error('Engine timeout'));
        }, remaining);
        const waiter = () => {
          clearTimeout(timer);
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          resolve();
        };
        this.waiters.push(waiter);
      });
    }
  }

  async ensureReady() {
    if (this.ready) return;
    await this.waitFor((l) => l === 'uciok');
    await this.waitFor((l) => l === 'readyok');
    this.ready = true;
  }

  run(task) {
    this.queue = this.queue.then(async () => {
      await this.ensureReady();
      return task(this);
    });
    return this.queue;
  }
}

// ── Engine Pool ──
class EnginePool {
  constructor(size) {
    this.enabled = ENGINE_AVAILABLE;
    this.size = size;
    this.workers = this.enabled ? Array.from({ length: size }, () => new EngineWorker()) : [];
    this.pointer = 0;
  }

  acquire() {
    const w = this.workers[this.pointer % this.workers.length];
    this.pointer += 1;
    return w;
  }

  async analyzePosition({ fen, depth = 12, multipv = 3 }) {
    if (!this.enabled) throw new Error('Stockfish is not available. Set STOCKFISH_BIN or build engine/Stockfish.');
    const key = `pos:${fen}:${depth}:${multipv}`;
    if (cache.has(key)) return cache.get(key);

    const result = await this.acquire().run(async (w) => {
      w.send(`setoption name MultiPV value ${multipv}`);
      w.send(`position fen ${fen}`);
      w.send(`go depth ${depth}`);

      const lines = [];
      while (true) {
        const line = await w.waitFor(() => true, 8000);
        if (line.startsWith('bestmove')) break;
        if (line.startsWith('info') && line.includes(' pv ') && line.includes(' multipv ')) {
          lines.push(line);
        }
      }

      const topById = new Map();
      for (const line of lines) {
        const m = line.match(/multipv (\d+).*score (cp|mate) (-?\d+).* pv (.+)$/);
        if (!m) continue;
        const mpv = Number(m[1]);
        const cp = m[2] === 'cp' ? Number(m[3]) : Number(m[3]) > 0 ? 100000 : -100000;
        topById.set(mpv, { rank: mpv, evalCp: cp, pv: m[4], uci: m[4].split(' ')[0] });
      }

      const topMoves = [...topById.values()].sort((a, b) => a.rank - b.rank);
      return { fen, topMoves, bestEvalCp: topMoves[0]?.evalCp ?? 0, source: 'stockfish' };
    });

    cache.set(key, result);
    return result;
  }

  async legalMoves(fen) {
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
    });
    cache.set(key, moves);
    return moves;
  }

  async evaluateMove(fen, move, movetime = 120) {
    return this.acquire().run(async (w) => {
      w.send('setoption name MultiPV value 1');
      w.send(`position fen ${fen} moves ${move}`);
      w.send(`go movetime ${movetime}`);
      let score = 0;
      while (true) {
        const line = await w.waitFor(() => true, 5000);
        if (line.startsWith('bestmove')) break;
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (m) score = m[1] === 'cp' ? Number(m[2]) : Number(m[2]) > 0 ? 100000 : -100000;
      }
      return score;
    });
  }
}

const pool = new EnginePool(Math.max(1, Math.min(4, os.cpus().length)));

// ── HTTP Helpers ──
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
}

function parseBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let destroyed = false;

    const onData = (d) => {
      if (destroyed) return;
      bytes += d.length;
      if (bytes > maxBytes) {
        destroyed = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      raw += d;
    };

    const onEnd = () => {
      if (destroyed) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
  });
}

// ── API Handler ──
async function handleApi(req, res) {
  // CORS headers for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // POST /api/analyze/position
    if (req.method === 'POST' && req.url === '/api/analyze/position') {
      const body = await parseBody(req);
      if (!body.fen) return sendJson(res, 400, { error: 'FEN is required' });
      const result = await pool.analyzePosition({
        fen: body.fen,
        depth: body.settings?.depth ?? 12,
        multipv: body.settings?.multiPv ?? 3
      });
      return sendJson(res, 200, result);
    }

    // POST /api/analyze/all-moves (SSE streaming)
    if (req.method === 'POST' && req.url === '/api/analyze/all-moves') {
      const body = await parseBody(req);
      if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable.' });
      if (!body.fen) return sendJson(res, 400, { error: 'FEN is required' });

      const fen = body.fen;
      const movetime = Number(body.settings?.movetimeMs ?? 120);
      const legal = await pool.legalMoves(fen);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });

      const rows = [];
      for (let i = 0; i < legal.length; i += 1) {
        if (clientDisconnected) return;
        const move = legal[i];
        const evalCp = await pool.evaluateMove(fen, move, movetime);
        // Negate eval since it's from opponent's perspective after the move
        const row = { uci: move, evalCp: -evalCp };
        rows.push(row);
        res.write(`data: ${JSON.stringify({ type: 'partial', progress: (i + 1) / legal.length, row })}\n\n`);
      }

      rows.sort((a, b) => b.evalCp - a.evalCp);
      const bestEvalCp = rows[0]?.evalCp ?? 0;
      const final = rows.map((r) => {
        const deltaCp = Math.max(0, bestEvalCp - r.evalCp);
        return { ...r, deltaCp, category: classify(deltaCp) };
      });

      res.write(`data: ${JSON.stringify({ type: 'final', result: { fen, moves: final, bestEvalCp, legalMoveCount: final.length } })}\n\n`);
      return res.end();
    }

    // POST /api/analyze/game
    if (req.method === 'POST' && req.url === '/api/analyze/game') {
      const body = await parseBody(req);
      const moves = parsePgnMoves(body.pgn || '');
      const fenSequence = body.fenSequence || [];
      const preMoveSequence = body.preMoveSequence || [];

      if (!fenSequence.length) {
        return sendJson(res, 400, { error: 'fenSequence is required for game analysis.' });
      }

      const plies = [];
      for (let i = 0; i < fenSequence.length; i += 1) {
        const fen = fenSequence[i];
        const postMoveAnalysis = await pool.analyzePosition({
          fen,
          depth: body.settings?.depth ?? 10,
          multipv: 1
        });
        const evalAfterMove = postMoveAnalysis.bestEvalCp;

        let deltaCp = 0;
        if (i > 0 && preMoveSequence[i]) {
          const preMoveAnalysis = await pool.analyzePosition({
            fen: preMoveSequence[i],
            depth: body.settings?.depth ?? 10,
            multipv: 1
          });
          const bestBeforeMove = preMoveAnalysis.bestEvalCp;
          deltaCp = Math.max(0, bestBeforeMove + evalAfterMove);
        }

        plies.push({
          ply: i + 1,
          san: moves[i] || `ply-${i + 1}`,
          fen,
          evalCp: evalAfterMove,
          deltaCp,
          category: classify(deltaCp)
        });
      }

      const turningPoints = plies.filter((p) => p.deltaCp >= 150);
      const evalGraph = plies.map((p) => ({ ply: p.ply, evalCp: p.evalCp }));
      return sendJson(res, 200, {
        opening: detectOpening(moves),
        plyCount: plies.length,
        plies,
        turningPoints,
        evalGraph
      });
    }

    // GET /api/opening
    if (req.method === 'GET' && req.url.startsWith('/api/opening')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const moves = (url.searchParams.get('moves') || '').split(' ').filter(Boolean);
      return sendJson(res, 200, detectOpening(moves));
    }

    // GET /api/status
    if (req.method === 'GET' && req.url === '/api/status') {
      return sendJson(res, 200, {
        engine: pool.enabled ? 'stockfish' : 'unavailable',
        workers: pool.size,
        cacheSize: cache.cache.size,
        uptime: process.uptime()
      });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('API error:', error.message);
    return sendJson(res, 500, { error: error.message });
  }
}

// ── Static File Server ──
function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];

  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch (_err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: Invalid URL encoding');
    return;
  }

  const normalized = decoded.replace(/^\/+/, '');
  const filePath = resolve(ROOT, normalized);

  const rootWithSep = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const ext = extname(filePath);
  const stream = createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    stream.pipe(res);
  });

  stream.on('error', (err) => {
    console.error(`Error serving ${reqPath.replace(/[\r\n]/g, '')}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Not found');
  });
}

// ── Server ──
http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`PawnForge running at http://localhost:${PORT} | stockfish=${pool.enabled ? 'on' : 'off'} | workers=${pool.size}`);
});
