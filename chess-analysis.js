// Pure chess helpers shared by the HTTP server and unit tests.

import { readFileSync } from 'node:fs';
import { createPosition } from './src/chess-position.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Mate scores are encoded as ±(MATE_SCORE - distance) so that shorter mates
// sort ahead of longer ones and clients can recover the mate distance.
export const MATE_SCORE = 100000;
export const MATE_THRESHOLD = MATE_SCORE - 1000;

// Evaluations are clamped to ±10 pawns before computing centipawn loss so a
// single mate score does not dominate averages such as ACPL.
export const LOSS_CLAMP_CP = 1000;

export class HttpError extends Error {
  constructor(statusCode, message, options) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

export function requireInteger(value, { name, defaultValue, min, max }) {
  const candidate = value ?? defaultValue;
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function validatePlacement(placement) {
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new HttpError(400, 'Invalid FEN.');
  for (const rank of ranks) {
    if (!/^[prnbqkPRNBQK1-8]+$/.test(rank)) throw new HttpError(400, 'Invalid FEN.');
    const squares = [...rank].reduce((count, symbol) => count + (Number(symbol) || 1), 0);
    if (squares !== 8) throw new HttpError(400, 'Invalid FEN.');
  }
  const count = (pattern) => (placement.match(pattern) || []).length;
  const counts = [count(/[prnbqkPRNBQK]/g), count(/P/g), count(/p/g), count(/K/g), count(/k/g)];
  if (counts[0] > 32 || counts[1] > 8 || counts[2] > 8 || counts[3] !== 1 || counts[4] !== 1) {
    throw new HttpError(400, 'Invalid FEN.');
  }
}

export function validateFen(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/.test(value)) {
    throw new HttpError(400, 'Invalid FEN.');
  }
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 6) throw new HttpError(400, 'Invalid FEN.');
  validatePlacement(fields[0]);
  const patterns = [/^[wb]$/, /^(?:-|[KQkq]+)$/, /^(?:-|[a-h][36])$/, /^\d+$/, /^[1-9]\d*$/];
  if (patterns.some((pattern, index) => !pattern.test(fields[index + 1])) || new Set(fields[2]).size !== fields[2].length) {
    throw new HttpError(400, 'Invalid FEN.');
  }
  const fen = fields.join(' ');
  try { createPosition(fen); }
  catch (error) { throw new HttpError(400, error.message, { cause: error }); }
  return fen;
}

// Convert a UCI `score cp|mate N` pair into side-to-move centipawns.
export function parseScore(kind, value) {
  const n = Number(value);
  if (kind === 'cp') return n;
  return n > 0 ? MATE_SCORE - n : -(MATE_SCORE + n);
}

export function clampEval(cp, limit = LOSS_CLAMP_CP) {
  return Math.max(-limit, Math.min(limit, cp));
}

export function classify(deltaCp) {
  if (deltaCp <= 20) return { key: 'best', label: 'Best' };
  if (deltaCp <= 60) return { key: 'good', label: 'Good' };
  if (deltaCp <= 150) return { key: 'inaccuracy', label: 'Inaccuracy' };
  if (deltaCp <= 300) return { key: 'mistake', label: 'Mistake' };
  return { key: 'blunder', label: 'Blunder' };
}

const PGN_RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

// Remove tags, comments and (possibly nested) variations in one linear pass.
// Tags and comments do not nest; variations can contain both.
function stripPgnAnnotations(pgn) {
  let text = '';
  const open = [];
  for (const ch of pgn) {
    const top = open.at(-1);
    if (top === '{' || top === '[') {
      if (ch === (top === '{' ? '}' : ']')) open.pop();
    } else if (ch === '{' || ch === '[' || ch === '(') {
      open.push(ch);
      text += ' ';
    } else if (ch === ')' && top === '(') {
      open.pop();
    } else if (!top) {
      text += ch;
    }
  }
  return text;
}

export function parsePgnMoves(pgn) {
  return stripPgnAnnotations(pgn)
    .split(/\s+/)
    .map((token) => token.replace(/^\d+\.+/, ''))
    .filter((token) => token && !PGN_RESULTS.has(token));
}

// Run `fn` over `items` with at most `limit` calls in flight. The first
// failure stops scheduling further items and is rethrown.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Map();
  let next = 0;
  let failed = false;
  const runner = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results.set(index, await fn(items.at(index), index));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return items.map((_item, index) => results.get(index));
}

// Opening names, ECO codes and lines from the lichess chess-openings dataset (CC0).
const OPENINGS_PATH = new URL('./data/openings.tsv', import.meta.url);

// Sources disagree on check, mate and annotation marks, so book lookups ignore them.
export function normaliseSan(san) {
  const text = String(san);
  let end = text.length;
  while (end > 0 && '+#!?'.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function parseOpenings(text) {
  const book = [];
  for (const row of text.split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t');
    if (eco && name && pgn) book.push({ eco, name, line: parsePgnMoves(pgn).map(normaliseSan) });
  }
  return book;
}

export const openingBook = parseOpenings(readFileSync(OPENINGS_PATH, 'utf8'));

// Exact line -> entry, and line prefix -> next move -> the shortest book line that move enters.
const bookByLine = new Map();
const continuationsByPrefix = new Map();
let longestBookLine = 0;
for (const item of openingBook) {
  const key = item.line.join(' ');
  if (!bookByLine.has(key)) bookByLine.set(key, item);
  longestBookLine = Math.max(longestBookLine, item.line.length);
  for (let ply = 0; ply < item.line.length; ply += 1) {
    const prefix = item.line.slice(0, ply).join(' ');
    let byMove = continuationsByPrefix.get(prefix);
    if (!byMove) {
      byMove = new Map();
      continuationsByPrefix.set(prefix, byMove);
    }
    const move = item.line[ply];
    const current = byMove.get(move);
    if (!current || item.line.length < current.line.length) byMove.set(move, item);
  }
}

export function findContinuations(moveList) {
  const byMove = continuationsByPrefix.get(moveList.map(normaliseSan).join(' '));
  return byMove ? [...byMove].map(([move, item]) => ({ move, name: item.name, eco: item.eco })) : [];
}

export function detectOpening(moveList, { startFen = START_FEN } = {}) {
  if (startFen.split(' ')[0] !== START_FEN.split(' ')[0]) {
    return { eco: null, name: 'Custom starting position', bookPlyRange: null, continuations: [] };
  }
  if (moveList.length === 0) {
    return { eco: null, name: 'Starting position', bookPlyRange: null, continuations: findContinuations(moveList) };
  }

  const moves = moveList.map(normaliseSan);
  let bestMatch = null;
  for (let ply = Math.min(moves.length, longestBookLine); ply > 0 && !bestMatch; ply -= 1) {
    bestMatch = bookByLine.get(moves.slice(0, ply).join(' ')) || null;
  }

  if (!bestMatch) {
    return { eco: 'A00', name: 'Uncommon Opening', bookPlyRange: null, continuations: findContinuations(moveList) };
  }
  return {
    eco: bestMatch.eco,
    name: bestMatch.name,
    bookPlyRange: [1, bestMatch.line.length],
    continuations: findContinuations(moveList)
  };
}

// ── Sparring strength ──
// Stockfish's UCI_Elo range (Search::Skill::LowestElo / HighestElo).
export const ENGINE_ELO_MIN = 1320;
export const ENGINE_ELO_MAX = 3190;

// "Throw the game" plays a believable loss: level through the opening, concede
// a little each move through the middlegame, and only collapse near `loseBy`.
export function losingPlan(moveNumber, loseBy) {
  // Converting a lost position takes most opponents about eight moves, so the
  // collapse starts that far ahead of the target.
  const holdUntil = Math.max(8, Math.round(loseBy * 0.35));
  const collapseFrom = loseBy - 8;
  if (moveNumber <= holdUntil) return { targetCp: 0, maxDropCp: 80, allowMated: false };
  if (moveNumber < collapseFrom) {
    const progress = (moveNumber - holdUntil) / (collapseFrom - holdUntil);
    return { targetCp: -Math.round(600 * progress), maxDropCp: 180, allowMated: false };
  }
  return { targetCp: -LOSS_CLAMP_CP, maxDropCp: 400, allowMated: true };
}

// Pick the candidate whose evaluation (side to move, best first) sits closest
// to the plan's target without giving away more than `maxDropCp` in one move.
export function chooseLosingMove(candidates, { moveNumber, loseBy, random = Math.random }) {
  if (candidates.length === 0) return null;
  const { targetCp, maxDropCp, allowMated } = losingPlan(moveNumber, loseBy);
  const bestCp = clampEval(candidates[0].evalCp);
  // Already behind schedule: play the best move so the game does not end early.
  if (bestCp <= targetCp) return candidates[0];
  const allowed = candidates.filter((c) => bestCp - clampEval(c.evalCp) <= maxDropCp
    && (allowMated || c.evalCp > -MATE_THRESHOLD));
  if (allowed.length === 0) return candidates[0];
  const distance = (c) => Math.abs(clampEval(c.evalCp) - targetCp);
  const closest = Math.min(...allowed.map(distance));
  // Vary the choice among near-equal candidates so repeated games differ.
  const pool = allowed.filter((c) => distance(c) <= closest + 25);
  return pool[Math.floor(random() * pool.length)];
}
