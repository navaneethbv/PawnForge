import http from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 4173);
const ROOT = resolve(process.cwd());
const STOCKFISH_BIN = process.env.STOCKFISH_BIN || (existsSync('/usr/games/stockfish') ? '/usr/games/stockfish' : 'stockfish');
const ENGINE_AVAILABLE = spawnSync(STOCKFISH_BIN, ['-h'], { stdio: 'ignore' }).status !== null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const cache = new Map();
const openingBook = [
  { line: ['e4', 'e5', 'Nf3', 'Nc6'], eco: 'C50', name: 'Italian Game' },
  { line: ['e4', 'c5'], eco: 'B20', name: 'Sicilian Defence' },
  { line: ['d4', 'd5', 'c4'], eco: 'D06', name: "Queen's Gambit" },
  { line: ['d4', 'Nf6', 'c4', 'g6'], eco: 'E60', name: "King's Indian Defence" },
  { line: ['e4', 'e6'], eco: 'C00', name: 'French Defence' },
  { line: ['e4', 'c6'], eco: 'B10', name: 'Caro-Kann Defence' }
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
  for (const item of openingBook) {
    if (item.line.every((m, i) => moveList[i] === m)) {
      return { eco: item.eco, name: item.name, bookPlyRange: [1, item.line.length] };
    }
  }
  return { eco: 'A00', name: 'Uncommon Opening', bookPlyRange: [1, Math.min(8, moveList.length || 8)] };
}

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

    this.send('uci');
    this.send('isready');
  }

  send(cmd) {
    this.proc.stdin.write(`${cmd}\n`);
  }

  async waitFor(predicate, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = this.lines.findIndex(predicate);
      if (idx !== -1) {
        const matched = this.lines[idx];
        this.lines = this.lines.slice(idx + 1);
        return matched;
      }
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    throw new Error('Engine timeout');
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
    if (!this.enabled) throw new Error('Stockfish is not available on this server. Set STOCKFISH_BIN.');
    const key = `pos:${fen}:${depth}:${multipv}`;
    if (cache.has(key)) return cache.get(key);

    const result = await this.acquire().run(async (w) => {
      w.send(`setoption name MultiPV value ${multipv}`);
      w.send(`position fen ${fen}`);
      w.send(`go depth ${depth}`);

      const lines = [];
      while (true) {
        const line = await w.waitFor(() => true, 6000);
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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function handleApi(req, res) {
  try {
    if (req.method === 'POST' && req.url === '/api/analyze/position') {
      const body = await parseBody(req);
      const result = await pool.analyzePosition({ fen: body.fen, depth: body.settings?.depth ?? 12, multipv: body.settings?.multiPv ?? 3 });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && req.url === '/api/analyze/all-moves') {
      const body = await parseBody(req);
      if (!pool.enabled) return sendJson(res, 503, { error: 'Stockfish unavailable on server.' });
      const fen = body.fen;
      const movetime = Number(body.settings?.movetimeMs ?? 120);
      const legal = await pool.legalMoves(fen);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      const rows = [];
      for (let i = 0; i < legal.length; i += 1) {
        const move = legal[i];
        const evalCp = await pool.evaluateMove(fen, move, movetime);
        const row = { uci: move, evalCp };
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

    if (req.method === 'POST' && req.url === '/api/analyze/game') {
      const body = await parseBody(req);
      const moves = parsePgnMoves(body.pgn || '');
      const fenSequence = body.fenSequence || [];
      if (!fenSequence.length) {
        return sendJson(res, 400, { error: 'fenSequence is required for game analysis in this deployment.' });
      }

      const plies = [];
      let prevBest = 0;
      for (let i = 0; i < fenSequence.length; i += 1) {
        const fen = fenSequence[i];
        const pos = await pool.analyzePosition({ fen, depth: body.settings?.depth ?? 10, multipv: 1 });
        const evalCp = pos.bestEvalCp;
        const deltaCp = i === 0 ? 0 : Math.abs(evalCp - prevBest);
        plies.push({ ply: i + 1, san: moves[i] || `ply-${i + 1}`, fen, evalCp, deltaCp, category: classify(deltaCp) });
        prevBest = evalCp;
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

    if (req.method === 'GET' && req.url.startsWith('/api/opening')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const moves = (url.searchParams.get('moves') || '').split(' ').filter(Boolean);
      return sendJson(res, 200, detectOpening(moves));
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
}

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const normalized = normalize(reqPath).replace(/^\.+(\/|\\)/, '');
  const filePath = resolve(join(ROOT, normalized));
  
  const rel = relative(ROOT, filePath);
  if (rel.startsWith('..') || resolve(ROOT, rel) !== filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(filePath).on('error', (err) => {
    const sanitizedPath = reqPath.replace(/[\r\n]/g, '');
    console.error(`Error serving ${sanitizedPath}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    } else {
      res.end();
    }
  }).pipe(res);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`PawnForge running at http://localhost:${PORT} | stockfish=${pool.enabled ? 'on' : 'off'}`);
});
