import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATE_SCORE, START_FEN, clampEval, classify, detectOpening, findContinuations,
  mapWithConcurrency, parsePgnMoves, parseScore, validateFen
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
  assert.equal(detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']).name, 'Ruy Lopez, Morphy Defence');
  assert.equal(detectOpening(['e4', 'e6', 'd4', 'd5', 'Nd2']).eco, 'C03');
  assert.deepEqual(detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'h6']).bookPlyRange, [1, 5]);
  assert.equal(detectOpening(['a3']).bookPlyRange, null);
  assert.equal(detectOpening([]).name, 'Starting position');
  assert.equal(detectOpening(['e5'], { startFen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1' }).name, 'Custom starting position');
});

test('continuations are unique and named after the line they enter', () => {
  const next = findContinuations(['e4', 'c5']);
  assert.equal(new Set(next.map((c) => c.move)).size, next.length);
  assert.equal(next.find((c) => c.move === 'c3').name, 'Sicilian Defence, Alapin Variation');
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
