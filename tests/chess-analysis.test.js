import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATE_SCORE, START_FEN, chooseLosingMove, clampEval, classify, detectOpening, findContinuations,
  losingPlan, mapWithConcurrency, parsePgnMoves, parseScore, validateFen
} from '../chess-analysis.js';

test('mate scores keep their distance and ordering', () => {
  assert.equal(parseScore('cp', '-35'), -35);
  assert.equal(parseScore('mate', '1'), MATE_SCORE - 1);
  assert.equal(parseScore('mate', '-3'), -(MATE_SCORE - 3));
  assert.equal(parseScore('mate', '0'), -MATE_SCORE);
  assert.ok(parseScore('mate', '1') > parseScore('mate', '4'));
  assert.ok(parseScore('mate', '-4') > parseScore('mate', '-1'));
});

test('centipawn loss is bounded for mate scores', () => {
  assert.equal(clampEval(MATE_SCORE), 1000);
  assert.equal(clampEval(-MATE_SCORE), -1000);
  assert.equal(clampEval(42), 42);
  assert.equal(classify(clampEval(MATE_SCORE - 1) + clampEval(-(MATE_SCORE - 3))).key, 'best');
});

test('FEN validation normalises whitespace and rejects malformed input', () => {
  assert.equal(validateFen(`  ${START_FEN.replaceAll(' ', '   ')} `), START_FEN);
  for (const bad of ['', START_FEN.replace(' w ', ' x '), START_FEN.replace('KQkq', 'KKkq'), '8/8/8/8/8/8/8/8 w - - 0 1']) {
    assert.throws(() => validateFen(bad), { statusCode: 400 });
  }
});

test('opening detection picks the most specific line', () => {
  assert.equal(detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']).name, 'Ruy Lopez: Morphy Defense');
  assert.equal(detectOpening(['e4', 'e6', 'd4', 'd5', 'Nd2']).eco, 'C03');
  assert.deepEqual(detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'h6']).bookPlyRange, [1, 5]);
  assert.equal(detectOpening(['Kf2']).bookPlyRange, null);
  // Deep book lines are recognised, not just the first few moves.
  const najdorf = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5', 'Nb3', 'Be6', 'f3'];
  assert.equal(detectOpening(najdorf).name, 'Sicilian Defense: Najdorf Variation, English Attack');
  assert.equal(detectOpening([]).name, 'Starting position');
  assert.equal(detectOpening(['e5'], { startFen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1' }).name, 'Custom starting position');
});

test('opening lookups ignore check and annotation marks', () => {
  // The book writes 3.Bb5+; a PGN may write it with or without the check sign or with annotations.
  for (const move of ['Bb5+', 'Bb5', 'Bb5+!?']) {
    assert.equal(detectOpening(['e4', 'c5', 'Nf3', 'd6', move]).name, 'Sicilian Defense: Moscow Variation');
  }
  assert.ok(findContinuations(['e4', 'c5', 'Nf3', 'd6']).some((c) => c.move === 'Bb5'));
});

test('continuations are unique and named after the line they enter', () => {
  const next = findContinuations(['e4', 'c5']);
  assert.equal(new Set(next.map((c) => c.move)).size, next.length);
  assert.equal(next.find((c) => c.move === 'c3').name, 'Sicilian Defense: Alapin Variation');
  assert.ok(findContinuations([]).some((c) => c.move === 'e4'));
});

test('mapWithConcurrency preserves order and bounds parallelism', async () => {
  let running = 0;
  let peak = 0;
  const result = await mapWithConcurrency([5, 1, 3, 2], 2, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running -= 1;
    return value * 10;
  });
  assert.deepEqual(result, [50, 10, 30, 20]);
  assert.equal(peak, 2);
  await assert.rejects(mapWithConcurrency([1, 2], 1, async () => { throw new Error('boom'); }), /boom/);
});

test('parsePgnMoves strips tags, comments, nested variations, move numbers and results', () => {
  const pgn = '[Event "a {b} (c)"]\n[Site "?"]\n\n1. e4 {best by test} e5 (1... c5 2. Nf3 (2. c3 d5) d6) 2.Nf3 Nc6 3...a6 1/2-1/2';
  assert.deepEqual(parsePgnMoves(pgn), ['e4', 'e5', 'Nf3', 'Nc6', 'a6']);
  assert.deepEqual(parsePgnMoves('1. d4 d5 *'), ['d4', 'd5']);
  assert.deepEqual(parsePgnMoves('1. e4 1-0'), ['e4']);
});

test('parsePgnMoves stays linear on unterminated annotations', () => {
  const start = performance.now();
  assert.deepEqual(parsePgnMoves(`1. e4 ${'{'.repeat(200000)}`), ['e4']);
  assert.deepEqual(parsePgnMoves(`1. e4 ${'1'.repeat(200000)}`).length, 2);
  assert.ok(performance.now() - start < 2000);
});

test('unsafe positions are rejected before they reach Stockfish', () => {
  const invalid = [
    '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1', // Opponent already in check.
    '8/8/8/8/8/8/4k3/4K3 w - - 0 1', // Adjacent kings.
    '4k3/8/8/8/8/8/8/P3K3 w - - 0 1', // Unpromoted pawn.
    '4k3/8/8/8/8/8/8/4K3 w K - 0 1', // Missing castling rook.
    '4k3/8/8/8/8/8/8/4K3 w - d6 0 1', // Missing en passant pawn.
    START_FEN.replace('0 1', '0 2147483647')
  ];
  for (const fen of invalid) assert.throws(() => validateFen(fen), { statusCode: 400 });
  // Being in check, checkmate, and a valid en passant target are legal input.
  for (const fen of [
    '4k3/8/8/8/8/8/4R3/4K3 b - - 0 1',
    '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'
  ]) assert.equal(validateFen(fen), fen);
});

const candidates = (...evals) => evals.map((evalCp, i) => ({ uci: `m${i}`, evalCp }));
const first = () => 0;

test('the losing plan holds level early, drifts in the middlegame, and collapses near the target', () => {
  assert.deepEqual(losingPlan(5, 30), { targetCp: 0, maxDropCp: 80, allowMated: false });
  assert.equal(losingPlan(11, 30).targetCp, 0);
  const middle = [13, 16, 19, 21].map((n) => losingPlan(n, 30).targetCp);
  assert.deepEqual([...middle].sort((a, b) => b - a), middle);
  assert.ok(middle.every((cp) => cp < 0 && cp > -600));
  assert.deepEqual(losingPlan(22, 30), { targetCp: -1000, maxDropCp: 400, allowMated: true });
  assert.equal(losingPlan(10, 50).targetCp, 0);
});

test('throwing the game never hangs material in the opening', () => {
  // A level opening position with one move that drops a knight.
  const move = chooseLosingMove(candidates(30, 10, -5, -290), { moveNumber: 4, loseBy: 30, random: first });
  assert.notEqual(move.uci, 'm3');
  // Already level: the plan keeps it level rather than conceding.
  assert.equal(chooseLosingMove(candidates(40, 5, -60), { moveNumber: 4, loseBy: 30, random: first }).uci, 'm1');
});

test('throwing the game concedes gradually toward the target and caps each concession', () => {
  // Move 19 of a 30-move plan targets -436cp; -300 is nearer but would give away 4 pawns at once.
  const move = chooseLosingMove(candidates(100, 20, -70, -300), { moveNumber: 19, loseBy: 30, random: first });
  assert.equal(move.uci, 'm2');
  // Nothing may give away more than the per-move cap, even if it is nearest the target.
  assert.equal(chooseLosingMove(candidates(400, 350, -300), { moveNumber: 19, loseBy: 30, random: first }).uci, 'm1');
});

test('throwing the game plays the best move when already behind schedule', () => {
  assert.equal(chooseLosingMove(candidates(-500, -700), { moveNumber: 16, loseBy: 30, random: first }).uci, 'm0');
});

test('throwing the game walks into mate only in the collapse phase', () => {
  const mated = -(MATE_SCORE - 2);
  assert.notEqual(chooseLosingMove(candidates(-100, mated), { moveNumber: 15, loseBy: 30, random: first }).uci, 'm1');
  assert.equal(chooseLosingMove(candidates(-700, mated), { moveNumber: 24, loseBy: 30, random: first }).uci, 'm1');
  assert.equal(chooseLosingMove([], { moveNumber: 29, loseBy: 30 }), null);
});
