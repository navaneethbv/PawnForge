import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Board after 1.e4 c6 2.d4 d5 3.e5 Bf5 4.c3 e6 5.Nf3 Nd7 6.Bd3 Ne7 7.h4, so Black is to move.
const board = 'r2qkb1r/pp1nnppp/2p1p3/3pPb2/3P3P/2PB1N2/PP3PP1/RNBQK2R';
const blackToMove = `${board} b - - 0 1`;

// Mirrors chess.com markup: pieces carry colour/type and square-<file><rank> classes, and
// move-list rows include clock text, which the old row-text heuristic could not parse.
async function chessComFixture(page, { moveList = true, highlights = [] } = {}) {
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div class="board" style="position:relative;width:480px;height:480px"></div>
    <div class="move-list">
      <div class="main-line-row"><span>7.</span>
        ${moveList ? '<div class="node white-move main-line-ply selected"><span class="node-highlight-content selected">h4</span></div>' : '<div class="node white-move main-line-ply"><span>h4</span></div>'}
        <span class="time">9 hrs</span>
      </div>
    </div></body></html>`);
  await page.evaluate(({ placement, highlights }) => {
    const boardEl = document.querySelector('.board');
    placement.split('/').forEach((row, rowIndex) => {
      let file = 1;
      for (const token of row) {
        if (/\d/.test(token)) { file += Number(token); continue; }
        const piece = document.createElement('div');
        const color = token === token.toUpperCase() ? 'w' : 'b';
        piece.className = `piece ${color}${token.toLowerCase()} square-${file}${8 - rowIndex}`;
        piece.style.cssText = `position:absolute;width:60px;height:60px;left:${(file - 1) * 60}px;top:${rowIndex * 60}px`;
        boardEl.appendChild(piece);
        file += 1;
      }
    });
    for (const square of highlights) {
      const highlight = document.createElement('div');
      highlight.className = `highlight square-${square}`;
      boardEl.appendChild(highlight);
    }
  }, { placement: board, highlights });
}

async function routeAnalysis(page) {
  const fens = [];
  await page.route('**/api/analyze/position', async (route) => {
    fens.push(route.request().postDataJSON().fen);
    await route.fulfill({ json: { topMoves: [{ uci: 'h7h6', evalCp: -20, pv: 'h7h6' }] } });
  });
  return fens;
}

async function injectOverlay(page) {
  await page.addScriptTag({ content: await readFile('overlay.js', 'utf8') });
}

test('auto detect reads the side to move from a chess.com move list with clock text', async ({ page }) => {
  const fens = await routeAnalysis(page);
  await chessComFixture(page);
  await injectOverlay(page);
  await page.locator('#pawnforge-approximate').check();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
  expect(fens.at(-1)).toBe(blackToMove);
  await expect(page.locator('#pawnforge-hint')).toContainText('Black to move (move list)');
});

test('auto detect falls back to the last-move highlight', async ({ page }) => {
  const fens = await routeAnalysis(page);
  await chessComFixture(page, { moveList: false, highlights: ['82', '84'] });
  await injectOverlay(page);
  await page.locator('#pawnforge-approximate').check();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
  expect(fens.at(-1)).toBe(blackToMove);
  await expect(page.locator('#pawnforge-hint')).toContainText('last-move highlight');
});

test('pressing Analyze on a DOM-only board opts into approximate analysis', async ({ page }) => {
  const fens = await routeAnalysis(page);
  await chessComFixture(page);
  await injectOverlay(page);
  await expect(page.locator('#pawnforge-hud-msg')).toContainText('Press Analyze');
  expect(fens).toHaveLength(0);
  await page.locator('#pawnforge-analyze').click();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
  await expect(page.locator('#pawnforge-approximate')).toBeChecked();
  expect(fens.at(-1)).toBe(blackToMove);
});

test('a move on the board is re-analysed within a second', async ({ page }) => {
  const fens = await routeAnalysis(page);
  await chessComFixture(page);
  await injectOverlay(page);
  await page.locator('#pawnforge-approximate').check();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
  const requestsBefore = fens.length;
  // Black answers 7...h6: the h7 pawn moves to h6.
  await page.evaluate(() => {
    const pawn = document.querySelector('.piece.square-87');
    pawn.classList.replace('square-87', 'square-86');
    pawn.style.top = '120px';
  });
  await expect.poll(() => fens.length, { timeout: 1000 }).toBeGreaterThan(requestsBefore);
  expect(fens.at(-1).split(' ')[0]).toBe('r2qkb1r/pp1nnpp1/2p1p2p/3pPb2/3P3P/2PB1N2/PP3PP1/RNBQK2R');
});

test('an overlay whose extension context is invalidated shuts down without unhandled errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await chessComFixture(page);
  await page.evaluate(() => {
    let alive = true;
    window.invalidateExtension = () => { alive = false; };
    window.chrome = {
      runtime: {
        get id() { return alive ? 'test' : undefined; },
        sendMessage: (_message, callback) => {
          if (!alive) throw new Error('Extension context invalidated.');
          if (typeof callback === 'function') callback({ fen: null });
          return Promise.resolve({ error: 'offline' });
        },
        onMessage: { addListener: () => {} }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    };
  });
  await injectOverlay(page);
  await expect(page.locator('#pawnforge-hud')).toBeVisible();
  await page.evaluate(() => window.invalidateExtension());
  await expect(page.locator('#pawnforge-hud')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#pawnforge-style')).toHaveCount(0);
  expect(errors).toEqual([]);
});

const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Serves fixed engine lines per FEN; unknown positions get a neutral reply.
async function routeLines(page, lines) {
  await page.route('**/api/analyze/position', async (route) => {
    const { fen } = route.request().postDataJSON();
    await route.fulfill({ json: { topMoves: lines[fen] || [{ uci: 'a2a3', evalCp: 0, pv: 'a2a3' }] } });
  });
}

async function playFen(page, fen) {
  await page.locator('#pawnforge-fen').fill(fen);
  await page.locator('#pawnforge-use-fen').click();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
}

test('the blunder detector flags a losing move and names the better one', async ({ page }) => {
  const afterF3 = 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1';
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  await routeLines(page, {
    [start]: [{ uci: 'e2e4', evalCp: 30, pv: 'e2e4 e7e5' }, { uci: 'd2d4', evalCp: 25, pv: 'd2d4' }],
    [afterF3]: [{ uci: 'e7e5', evalCp: 350, pv: 'e7e5' }],
    [afterE4]: [{ uci: 'e7e5', evalCp: -30, pv: 'e7e5' }]
  });
  await page.setContent('<!doctype html><body></body>');
  await injectOverlay(page);
  await playFen(page, start);
  await expect(page.locator('#pawnforge-verdict')).toBeEmpty();

  await playFen(page, afterF3);
  const verdict = page.locator('#pawnforge-verdict');
  await expect(verdict).toContainText('Blunder');
  await expect(verdict).toContainText('White played F2➜F3');
  await expect(verdict).toContainText('+0.30 → -3.50');
  await expect(verdict).toContainText('Better was E2➜E4');

  await playFen(page, start);
  await playFen(page, afterE4);
  await expect(verdict).toContainText('Best');
  await expect(verdict).not.toContainText('Better was');
});

test('the blunder detector recognises castling, en passant and promotion, and skips non-adjacent positions', async ({ page }) => {
  const afterE4E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  await routeLines(page, { [afterE4E5]: [{ uci: 'g1f3', evalCp: 30, pv: 'g1f3' }] });
  await page.setContent('<!doctype html><body></body>');
  await injectOverlay(page);
  const verdict = page.locator('#pawnforge-verdict');
  const cases = [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1', 'White played E1➜G1'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1', 'White played E5➜D6'],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'Q3k3/8/8/8/8/8/8/4K3 b - - 0 1', 'White played A7➜A8'],
    ['4k3/8/8/8/8/8/8/4K2R b K - 0 1', '3k4/8/8/8/8/8/8/4K2R w K - 1 2', 'Black played E8➜D8']
  ];
  for (const [before, after, text] of cases) {
    await playFen(page, before);
    await playFen(page, after);
    await expect(verdict).toContainText(text);
  }
  // Two plies apart (1.e4 e5): no single move explains the change, so no verdict.
  await playFen(page, start);
  await playFen(page, afterE4E5);
  await expect(page.locator('#pawnforge-hud-msg')).toContainText('G1 to F3');
  await expect(verdict).toBeEmpty();
});
