// Pure chess helpers shared by the HTTP server and unit tests.

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Mate scores are encoded as ±(MATE_SCORE - distance) so that shorter mates
// sort ahead of longer ones and clients can recover the mate distance.
export const MATE_SCORE = 100000;
export const MATE_THRESHOLD = MATE_SCORE - 1000;

// Evaluations are clamped to ±10 pawns before computing centipawn loss so a
// single mate score does not dominate averages such as ACPL.
export const LOSS_CLAMP_CP = 1000;

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
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
  return fields.join(' ');
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

export function parsePgnMoves(pgn) {
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

// Run `fn` over `items` with at most `limit` calls in flight. The first
// failure stops scheduling further items and is rethrown.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const runner = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

export const openingBook = [
  // Open games (1.e4 e5)
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], eco: 'C60', name: 'Ruy Lopez' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], eco: 'C70', name: 'Ruy Lopez, Morphy Defence' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6'], eco: 'C68', name: 'Ruy Lopez, Exchange Variation' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'], eco: 'C65', name: 'Ruy Lopez, Berlin Defence' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], eco: 'C50', name: 'Italian Game' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], eco: 'C50', name: 'Giuoco Piano' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], eco: 'C55', name: 'Two Knights Defence' },
  { line: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'], eco: 'C44', name: 'Scotch Game' },
  { line: ['e4', 'e5', 'Nf3', 'Nf6'], eco: 'C42', name: 'Petrov Defence' },
  { line: ['e4', 'e5', 'Nf3', 'd6'], eco: 'C41', name: 'Philidor Defence' },
  { line: ['e4', 'e5', 'f4'], eco: 'C30', name: "King's Gambit" },
  { line: ['e4', 'e5', 'Nc3'], eco: 'C25', name: 'Vienna Game' },
  { line: ['e4', 'e5', 'd4'], eco: 'C21', name: 'Center Game' },

  // Sicilian Defence
  { line: ['e4', 'c5'], eco: 'B20', name: 'Sicilian Defence' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3'], eco: 'B56', name: 'Sicilian Defence, Open' },
  { line: ['e4', 'c5', 'Nf3', 'Nc6'], eco: 'B30', name: 'Sicilian Defence, Old Sicilian' },
  { line: ['e4', 'c5', 'Nf3', 'e6'], eco: 'B40', name: 'Sicilian Defence, French Variation' },
  { line: ['e4', 'c5', 'c3'], eco: 'B22', name: 'Sicilian Defence, Alapin Variation' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], eco: 'B90', name: 'Sicilian Defence, Najdorf Variation' },
  { line: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'], eco: 'B70', name: 'Sicilian Defence, Dragon Variation' },

  // French Defence
  { line: ['e4', 'e6'], eco: 'C00', name: 'French Defence' },
  { line: ['e4', 'e6', 'd4', 'd5'], eco: 'C00', name: 'French Defence' },
  { line: ['e4', 'e6', 'd4', 'd5', 'Nc3'], eco: 'C10', name: 'French Defence, Paulsen Variation' },
  { line: ['e4', 'e6', 'd4', 'd5', 'Nd2'], eco: 'C03', name: 'French Defence, Tarrasch Variation' },
  { line: ['e4', 'e6', 'd4', 'd5', 'e5'], eco: 'C02', name: 'French Defence, Advance Variation' },
  { line: ['e4', 'e6', 'd4', 'd5', 'exd5'], eco: 'C01', name: 'French Defence, Exchange Variation' },

  // Caro-Kann
  { line: ['e4', 'c6'], eco: 'B10', name: 'Caro-Kann Defence' },
  { line: ['e4', 'c6', 'd4', 'd5'], eco: 'B12', name: 'Caro-Kann Defence' },
  { line: ['e4', 'c6', 'd4', 'd5', 'Nc3'], eco: 'B15', name: 'Caro-Kann Defence, Main Line' },
  { line: ['e4', 'c6', 'd4', 'd5', 'e5'], eco: 'B12', name: 'Caro-Kann Defence, Advance Variation' },

  // Scandinavian
  { line: ['e4', 'd5'], eco: 'B01', name: 'Scandinavian Defence' },
  { line: ['e4', 'd5', 'exd5', 'Qxd5'], eco: 'B01', name: 'Scandinavian Defence, Mieses-Kotroc Variation' },

  // Pirc / Modern
  { line: ['e4', 'd6'], eco: 'B07', name: 'Pirc Defence' },
  { line: ['e4', 'g6'], eco: 'B06', name: 'Modern Defence' },

  // Alekhine
  { line: ['e4', 'Nf6'], eco: 'B02', name: "Alekhine's Defence" },

  // Queen's Gambit
  { line: ['d4', 'd5', 'c4'], eco: 'D06', name: "Queen's Gambit" },
  { line: ['d4', 'd5', 'c4', 'e6'], eco: 'D30', name: "Queen's Gambit Declined" },
  { line: ['d4', 'd5', 'c4', 'dxc4'], eco: 'D20', name: "Queen's Gambit Accepted" },
  { line: ['d4', 'd5', 'c4', 'c6'], eco: 'D10', name: 'Slav Defence' },
  { line: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'], eco: 'D53', name: "Queen's Gambit Declined, Classical" },
  { line: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Nf3'], eco: 'D37', name: "Queen's Gambit Declined, Three Knights" },

  // Indian Defences
  { line: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4'], eco: 'E70', name: "King's Indian Defence" },
  { line: ['d4', 'Nf6', 'c4', 'g6'], eco: 'E60', name: "King's Indian Defence" },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'], eco: 'E20', name: 'Nimzo-Indian Defence' },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'], eco: 'E12', name: "Queen's Indian Defence" },
  { line: ['d4', 'Nf6', 'c4', 'e6', 'g3'], eco: 'E00', name: 'Catalan Opening' },
  { line: ['d4', 'Nf6', 'c4', 'c5'], eco: 'A56', name: 'Benoni Defence' },
  { line: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6'], eco: 'A60', name: 'Modern Benoni' },

  // English
  { line: ['c4'], eco: 'A10', name: 'English Opening' },
  { line: ['c4', 'e5'], eco: 'A20', name: 'English Opening, Reversed Sicilian' },
  { line: ['c4', 'Nf6'], eco: 'A15', name: 'English Opening, Anglo-Indian Defence' },
  { line: ['c4', 'c5'], eco: 'A30', name: 'English Opening, Symmetrical Variation' },

  // Réti
  { line: ['Nf3', 'd5', 'c4'], eco: 'A09', name: 'Réti Opening' },
  { line: ['Nf3'], eco: 'A04', name: 'Réti Opening' },

  // London / Trompowsky
  { line: ['d4', 'Nf6', 'Bf4'], eco: 'A45', name: 'London System' },
  { line: ['d4', 'd5', 'Bf4'], eco: 'D00', name: 'London System' },
  { line: ['d4', 'Nf6', 'Bg5'], eco: 'A45', name: 'Trompowsky Attack' },

  // Dutch
  { line: ['d4', 'f5'], eco: 'A80', name: 'Dutch Defence' },

  // Grünfeld
  { line: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'], eco: 'D80', name: 'Grünfeld Defence' },

  // Bird
  { line: ['f4'], eco: 'A02', name: "Bird's Opening" },

  // Other openings
  { line: ['e4'], eco: 'B00', name: "King's Pawn Opening" },
  { line: ['e4', 'e5'], eco: 'C20', name: "King's Pawn Game" },
  { line: ['e4', 'e5', 'Nf3'], eco: 'C40', name: "King's Knight Opening" },
  { line: ['e4', 'e5', 'Nf3', 'Nc6'], eco: 'C44', name: "King's Knight Opening, Normal Variation" },
  { line: ['d4'], eco: 'A40', name: "Queen's Pawn Opening" },
  { line: ['d4', 'd5'], eco: 'D00', name: "Queen's Pawn Game" },
  { line: ['d4', 'Nf6'], eco: 'A45', name: 'Indian Defence' },
  { line: ['d4', 'Nf6', 'c4'], eco: 'A50', name: 'Indian Defence, Normal Variation' },
];

export function findContinuations(moveList) {
  // Name each next move after the shortest book line it enters.
  const byMove = new Map();
  for (const item of openingBook) {
    if (item.line.length <= moveList.length || !moveList.every((m, i) => item.line[i] === m)) continue;
    const move = item.line[moveList.length];
    const current = byMove.get(move);
    if (!current || item.line.length < current.line.length) byMove.set(move, item);
  }
  return [...byMove].map(([move, item]) => ({ move, name: item.name, eco: item.eco }));
}

export function detectOpening(moveList, { startFen = START_FEN } = {}) {
  if (startFen.split(' ')[0] !== START_FEN.split(' ')[0]) {
    return { eco: null, name: 'Custom starting position', bookPlyRange: null, continuations: [] };
  }
  if (moveList.length === 0) {
    return { eco: null, name: 'Starting position', bookPlyRange: null, continuations: findContinuations(moveList) };
  }

  let bestMatch = null;
  for (const item of openingBook) {
    if (item.line.every((m, i) => moveList[i] === m) && item.line.length > (bestMatch?.line.length ?? 0)) {
      bestMatch = item;
    }
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
