import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
async function load(page) {
  // Every library is served by PawnForge itself, so any outside request is a regression.
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), r => r.abort());
  await page.goto('/');
  await expect(page.locator('#board img')).toHaveCount(32);
}
async function drag(page, from, to) {
  await page.locator('#board').evaluate(el => el.scrollIntoView({ block: 'center' }));
  const a = await page.locator(`#board .square-${from}`).boundingBox();
  const b = await page.locator(`#board .square-${to}`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('valid FEN updates both board and game; invalid drags snap back', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await load(page);
  await page.locator('#fenInput').fill(afterE4);
  await page.locator('#loadFenBtn').click();
  await expect(page.locator('#board .square-e4 img')).toHaveCount(1);
  await drag(page, 'e7', 'e4');
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await expect(page.locator('#board .square-e7 img')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('history replay preserves the move sequence used for opening detection', async ({ page }) => {
  await load(page);
  await drag(page, 'e2', 'e4');
  await drag(page, 'e7', 'e5');
  await page.locator('#moveNavPrev').click();
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await page.locator('[data-tab="opening"]').click();
  const request = page.waitForRequest(r => r.url().includes('/api/opening?moves=e4'));
  await page.locator('#openingBtn').click(); await request;
});

test('turning sparring off discards a delayed engine move', async ({ page }) => {
  await load(page);
  let release; const gate = new Promise(r => { release = r; });
  let requested; const started = new Promise(r => { requested = r; });
  await page.route('**/api/analyze/position', async route => {
    requested(); await gate;
    await route.fulfill({ json: { topMoves: [{ uci: 'e7e5' }], bestEvalCp: 0 } }).catch(() => {});
  });
  await page.locator('.sparring-toggle-label').click();
  await drag(page, 'e2', 'e4'); await started;
  await page.locator('.sparring-toggle-label').click(); release();
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await page.waitForTimeout(200);
  await expect(page.locator('#board .square-e7 img')).toHaveCount(1);
});

test('query parameters work and foreign origins/hosts are rejected', async ({ request }) => {
  expect((await request.get('/?embed=1&coach=1')).status()).toBe(200);
  for (const path of ['/server.js', '/package.json', '/src/../server.js', '/src/%2F..%2Fserver.js', '/src/unknown.js']) {
    expect((await request.get(path)).status()).toBe(404);
  }

  expect((await request.get('/api/status', { headers: { Origin: 'https://example.org' } })).status()).toBe(403);
  expect((await request.get('/api/status', { headers: { Host: 'example.org:4189' } })).status()).toBe(403);
  expect((await request.get('/api/status')).headers()['access-control-allow-origin']).toBeUndefined();
});

test('real engine returns legal moves and completes explorer streaming', async ({ request }) => {
  const response = await request.post('/api/analyze/position', { data: { fen: start, settings: { depth: 4, multiPv: 1 } } });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).topMoves[0].uci).toMatch(/^[a-h][1-8][a-h][1-8]/);
  const stream = await request.post('/api/analyze/all-moves', { data: { fen: start, settings: { movetimeMs: 20 } } });
  expect(await stream.text()).toContain('"legalMoveCount":20');
  const review = await request.post('/api/analyze/game', { data: { fenSequence: [afterE4], preMoveSequence: [start], moves: ['e4'], settings: { depth: 4 } } });
  expect(review.ok()).toBeTruthy();
  expect((await review.json()).plies[0]).toMatchObject({ san: 'e4', fen: afterE4 });
  const invalid = await request.post('/api/analyze/position', { data: { fen: start.replace(' w ', ' x ') } });
  expect(invalid.status()).toBe(400);

});

test('DOM overlay requires opting into approximate analysis', async ({ page }) => {
  await load(page);
  await page.locator('#fenInput').evaluate(el => el.remove());
  await page.locator('#board').evaluate(el => { el.dataset.turn = 'w'; });
  await page.addScriptTag({ content: await readFile('overlay.js', 'utf8') });
  await expect(page.locator('#pawnforge-hud-msg')).toContainText('Press Analyze');
  await page.locator('#pawnforge-endpoint').fill('http://127.0.0.1:4189/api/analyze/position');
  await page.locator('#pawnforge-save-endpoint').click();
  await page.locator('#pawnforge-approximate').check();
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#pawnforge-hud')).toContainText('castling and en passant disabled');
});

test('overlay keeps an endpoint entered before stored settings finish loading', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const stored = { endpoint: 'http://127.0.0.1:9/api/analyze/position', sideMode: 'b' };
    window.releaseStoredSettings = null;
    window.chrome = {
      runtime: { id: 'test', sendMessage: async () => ({ error: 'offline' }) },
      storage: { local: {
        get: () => new Promise(resolve => { window.releaseStoredSettings = () => resolve(stored); }),
        set: async () => {}
      } }
    };
  });
  await page.addScriptTag({ content: await readFile('overlay.js', 'utf8') });
  const typed = 'http://127.0.0.1:4189/api/analyze/position';
  await page.locator('#pawnforge-endpoint').fill(typed);
  await page.locator('#pawnforge-side').selectOption('w');
  await page.evaluate(() => window.releaseStoredSettings());
  await expect(page.locator('#pawnforge-side')).toHaveValue('w');
  await expect(page.locator('#pawnforge-endpoint')).toHaveValue(typed);
  await page.locator('#pawnforge-save-endpoint').click();
  await expect(page.locator('#pawnforge-hud-msg')).not.toContainText('Use http://');
  await expect(page.locator('#pawnforge-endpoint')).toHaveValue(typed);
});

test('a custom Black-to-move PGN attributes mistakes and move numbers correctly', async ({ page }) => {
  await load(page);
  await page.route('**/api/analyze/game', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: {
      opening: { eco: 'A00', name: 'Custom position', bookPlyRange: [0, 0] },
      plyCount: 1, turningPoints: [1],
      plies: [{ ply: 1, san: body.moves[0], fen: body.fenSequence[0], evalCp: 0, deltaCp: 200, category: { key: 'mistake', label: 'Mistake' } }]
    } });
  });
  await page.locator('[data-tab="game-review"]').click();
  await page.locator('#pgnInput').fill(`[SetUp "1"]\n[FEN "${afterE4}"]\n\n1... e5 *`);
  await page.locator('#analyzeGameBtn').click();
  await expect(page.locator('#gameMoveList')).toContainText('1...');
  await expect(page.locator('.summary-card').filter({ hasText: 'Black ACPL' })).toContainText('200.0');
  await expect(page.locator('.summary-card').filter({ hasText: 'White ACPL' })).toContainText('0');
  await expect(page.locator('.quality-table tr').filter({ hasText: 'Mistake' }).locator('td')).toHaveText(['Mistake', '0', '1']);
  await expect(page.locator('.quality-table tr').filter({ hasText: 'Best' }).locator('td')).toHaveText(['Best', '0', '0']);
  await page.locator('.game-move').click();
  await expect(page.locator('#board .square-e5 img')).toHaveCount(1);
  await expect(page.locator('#moveList')).toContainText('1...');
});

test('a newer review keeps its own FEN sequence when an older request resolves', async ({ page }) => {
  await load(page);
  let release; const old = new Promise(r => { release = r; });
  let requested; const started = new Promise(r => { requested = r; });
  await page.route('**/api/analyze/game', async route => {
    const body = route.request().postDataJSON();
    if (body.moves[0] === 'e4') { requested(); await old; }
    await route.fulfill({ json: {
      opening: { eco: 'A00', name: 'Test', bookPlyRange: [1, 1] }, plyCount: 1, turningPoints: [],
      plies: [{ ply: 1, san: body.moves[0], fen: body.fenSequence[0], evalCp: 0, deltaCp: 0, category: { key: 'best', label: 'Best' } }]
    } }).catch(() => {});
  });
  await page.locator('[data-tab="game-review"]').click();
  await page.locator('#pgnInput').fill('1. e4 *'); await page.locator('#analyzeGameBtn').click(); await started;
  await page.locator('#pgnInput').fill('1. d4 *'); await page.locator('#analyzeGameBtn').click();
  await expect(page.locator('.game-move')).toHaveText('d4'); release();
  await page.locator('.game-move').click();
  await expect(page.locator('#board .square-d4 img')).toHaveCount(1);
  await expect(page.locator('#board .square-e2 img')).toHaveCount(1);
});

test('coach and sparring toggles are keyboard accessible; mobile has no horizontal overflow', async ({ page }) => {
  await load(page);
  await page.locator('#sparringToggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#sparringToggle')).toBeChecked();
  await page.keyboard.press('Space');
  await expect(page.locator('#sparringToggle')).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => `${el.tagName}.${el.className}`) }))).toMatchObject({ width: 390, scroll: 390 });
  await page.screenshot({ path: 'test-results/pawnforge-mobile.png', fullPage: true });
});


test('overlay polling does not discard an analysis slower than its poll interval', async ({ page }) => {
  await load(page);
  let requests = 0;
  await page.route('**/api/analyze/position', async route => {
    requests += 1;
    await new Promise(resolve => setTimeout(resolve, 1800));
    await route.fulfill({ json: { topMoves: [{ uci: 'e2e4', evalCp: 20 }] } });
  });
  await page.addScriptTag({ content: await readFile('overlay.js', 'utf8') });
  await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible();
  expect(requests).toBe(1);
});

test('undo takes back the engine reply in sparring and never wipes history from the start position', async ({ page }) => {
  await load(page);
  await page.route('**/api/analyze/position', route => route.fulfill({ json: { topMoves: [{ uci: 'e7e5', evalCp: 0, pv: 'e7e5' }], bestEvalCp: 0 } }));
  await page.locator('.sparring-toggle-label').click();
  await drag(page, 'e2', 'e4');
  await expect(page.locator('#moveList .move-san')).toHaveText(['e4', 'e5']);
  await page.locator('#undoBtn').click();
  await expect(page.locator('#fenInput')).toHaveValue(start);
  await expect(page.locator('#moveList .move-san')).toHaveCount(0);

  await page.locator('.sparring-toggle-label').click();
  await expect(page.locator('#sparringToggle')).not.toBeChecked();
  await expect(page.locator('#board .square-e2 img')).toHaveCount(1); // undo animation finished
  await expect(page.locator('#board .square-e5 img')).toHaveCount(0);
  await drag(page, 'e2', 'e4');
  await expect(page.locator('#moveList .move-san')).toHaveText(['e4']);
  await page.locator('#moveNavStart').click();
  await page.locator('#undoBtn').click();
  await expect(page.locator('#moveList .move-san')).toHaveText(['e4']);
});

test('a FEN without move counters is normalised before numbering moves', async ({ page }) => {
  await load(page);
  await page.locator('#fenInput').fill('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
  await page.locator('#fenInput').press('Enter');
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await drag(page, 'e7', 'e5');
  await expect(page.locator('#moveList')).toContainText('1...');
  await expect(page.locator('#moveList')).not.toContainText('NaN');
  await page.locator('#fenInput').fill('not a fen');
  await page.locator('#loadFenBtn').click();
  await expect(page.locator('#fenError')).toBeVisible();
  await expect(page.locator('#board .square-e5 img')).toHaveCount(1);
});

test('real-engine workflows render analysis, coach, explorer filters and a complete game review', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page);
  await page.locator('#depthSelect').selectOption('8');
  await page.locator('#analyzePositionBtn').click();
  await expect(page.locator('.pv-line')).toHaveCount(3);
  await page.locator('.pv-line').first().click();
  await expect(page.locator('#moveList .move-san')).toHaveCount(1);
  await page.locator('#resetBtn').click();

  await page.locator('.coach-toggle-label').click();
  await expect(page.locator('.coach-candidate-pill')).toHaveCount(5);
  await expect(page.locator('.coach-candidate-pill .pill-rank')).toHaveText(['#1', '#2', '#3', '#4', '#5']);
  await page.locator('#applyCoachMoveBtn').click();
  await expect(page.locator('#moveList .move-san')).toHaveCount(1);
  await page.locator('.coach-toggle-label').click();
  await page.locator('#resetBtn').click();

  await page.locator('[data-tab="explorer"]').click();
  await page.locator('#movetimeSelect').selectOption('50');
  await page.locator('#analyzeAllMovesBtn').click();
  await expect(page.locator('#allMovesTable tbody tr')).toHaveCount(20);
  await page.locator('#allMovesTable').focus();
  await expect(page.locator('#allMovesTable')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('#allMovesTable').evaluate(table => table.scrollTop)).toBeGreaterThan(0);
  await page.locator('.piece-badge[title="Show only knight moves"]').click();
  await expect(page.locator('#allMovesTable tbody tr')).toHaveCount(4);
  await page.locator('.piece-badge[title="Show only knight moves"]').click();
  await page.locator('#filterPiece').selectOption('captures');
  await expect(page.locator('#allMovesTable')).toContainText('No moves match');
  await page.locator('#filterPiece').selectOption('');
  await page.locator('#sortMoves').selectOption('piece');
  await expect(page.locator('#allMovesTable .move-cell').first()).toContainText('N');

  await page.locator('[data-tab="opening"]').click();
  await page.locator('#openingBtn').click();
  await page.locator('.continuation-row').filter({ has: page.locator('.continuation-move', { hasText: /^e4$/ }) }).click();
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await expect(page.locator('#openingResult')).toContainText("King's Pawn Game");

  await page.locator('[data-tab="game-review"]').click();
  await page.locator('#gameDepthSelect').selectOption('8');
  await page.locator('#pgnInput').fill('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0');
  await page.locator('#analyzeGameBtn').click();
  await expect(page.locator('.game-move')).toHaveCount(7);
  await expect(page.locator('#gameSummary')).toContainText('7 plies');
  await page.locator('#navLast').click();
  await expect(page.locator('#evalDisplay')).toHaveText('#');
  await expect(page.locator('#board .square-f7 img')).toHaveAttribute('data-piece', 'wQ');
  await page.locator('#navPrev').click();
  await expect(page.locator('#board .square-h5 img')).toHaveAttribute('data-piece', 'wQ');
  await page.locator('#navLast').click();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `test-results/review-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('a failed replacement PGN review clears the previous summary and graph', async ({ page }) => {
  await load(page);
  await page.locator('[data-tab="game-review"]').click();
  await page.locator('#pgnInput').fill('1. e4 e5 *');
  await page.locator('#analyzeGameBtn').click();
  await expect(page.locator('#gameSummary')).toBeVisible();
  await page.locator('#pgnInput').fill('not a chess game');
  await page.locator('#analyzeGameBtn').click();
  await expect(page.locator('#gameMoveList')).toContainText('Could not read the PGN');
  await expect(page.locator('#gameSummary')).toBeHidden();
  await expect(page.locator('#evalGraphContainer')).toBeHidden();
});

test('resetting during a PGN review dismisses its cancelled progress indicator', async ({ page }) => {
  await load(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/analyze/game', async route => {
    await gate;
    await route.abort().catch(() => {});
  });
  await page.locator('[data-tab="game-review"]').click();
  await page.locator('#pgnInput').fill('1. e4 e5 *');
  const requested = page.waitForRequest('**/api/analyze/game');
  await page.locator('#analyzeGameBtn').click();
  await requested;
  await expect(page.locator('#gameProgress')).toBeVisible();
  await page.locator('#resetBtn').click();
  release();
  await expect(page.locator('#gameProgress')).toBeHidden();
  await expect(page.locator('#fenInput')).toHaveValue(start);
});

test('opening continuations cannot play the engine turn during sparring', async ({ page }) => {
  await load(page);
  await page.locator('[data-tab="opening"]').click();
  await page.locator('#openingBtn').click();
  const continuation = page.locator('.continuation-row').filter({ has: page.locator('.continuation-move', { hasText: /^e4$/ }) });
  await expect(continuation).toBeVisible();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/analyze/position', async route => {
    await gate;
    await route.fulfill({ json: { topMoves: [{ uci: 'd2d4', evalCp: 0, pv: 'd2d4' }], bestEvalCp: 0 } }).catch(() => {});
  });
  await page.locator('#sparringColor').selectOption('b');
  const requested = page.waitForRequest('**/api/analyze/position');
  await page.locator('.sparring-toggle-label').click();
  await requested;
  await continuation.click();
  const fenWhileThinking = await page.locator('#fenInput').inputValue();
  release();
  expect(fenWhileThinking).toBe(start);
  await expect(page.locator('#moveList .move-san')).toHaveText(['d4']);
});

test('terminal positions distinguish checkmate from stalemate with the real engine', async ({ request }) => {
  for (const [fen, score] of [
    ['7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', -100000],
    ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 0]
  ]) {
    const response = await request.post('/api/analyze/position', { data: { fen, settings: { depth: 4, multiPv: 3 } } });
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ bestEvalCp: score, topMoves: [] });
  }
});

test('a pawn can underpromote through the promotion picker, and Escape cancels it', async ({ page }) => {
  const promotable = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  await load(page);
  await page.locator('#fenInput').fill(promotable);
  await page.locator('#loadFenBtn').click();

  await drag(page, 'a7', 'a8');
  const picker = page.getByRole('dialog', { name: 'Choose a promotion piece' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Queen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(page.locator('#fenInput')).toHaveValue(promotable);
  await expect(page.locator('#board .square-a7 img')).toHaveCount(1);
  // chessboard.js ignores new drags until the snapback animation hides its floating piece.
  await expect(page.locator('body > img:visible')).toHaveCount(0);

  await drag(page, 'a7', 'a8');
  await picker.getByRole('button', { name: 'Knight' }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator('#fenInput')).toHaveValue('N3k3/8/8/8/8/8/8/4K3 b - - 0 1');
  await expect(page.locator('#moveList')).toContainText('a8=N');
});

test('the played game downloads as PGN, including a custom start and the result', async ({ page }) => {
  await load(page);
  await drag(page, 'f2', 'f3');
  await drag(page, 'e7', 'e5');
  await drag(page, 'g2', 'g4');
  await drag(page, 'd8', 'h4');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadPgnBtn').click()]);
  expect(download.suggestedFilename()).toMatch(/^pawnforge-\d{4}-\d{2}-\d{2}\.pgn$/);
  const pgn = await readFile(await download.path(), 'utf8');
  expect(pgn).toContain('[Event "PawnForge analysis"]');
  expect(pgn).toContain('[Result "0-1"]');
  expect(pgn).toContain('1. f3 e5 2. g4 Qh4# 0-1');

  await page.locator('#fenInput').fill('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  await page.locator('#loadFenBtn').click();
  const [custom] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadPgnBtn').click()]);
  const customPgn = await readFile(await custom.path(), 'utf8');
  expect(customPgn).toContain('[SetUp "1"]');
  expect(customPgn).toContain('[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]');
});

test('the board history and selected move survive a reload; a corrupt save starts fresh', async ({ page }) => {
  await load(page);
  await drag(page, 'e2', 'e4');
  await drag(page, 'e7', 'e5');
  await page.locator('#moveNavPrev').click();
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);

  await page.reload();
  await expect(page.locator('#board img')).toHaveCount(32);
  await expect(page.locator('#moveList .move-san')).toHaveText(['e4', 'e5']);
  await expect(page.locator('#moveList .move-san.active')).toHaveText('e4');
  await expect(page.locator('#fenInput')).toHaveValue(afterE4);
  await expect(page.locator('#board .square-e4 img')).toHaveCount(1);
  await page.locator('#moveNavNext').click();
  await expect(page.locator('#board .square-e5 img')).toHaveCount(1);

  await page.evaluate(() => localStorage.setItem('pawnforge_session', JSON.stringify({ initialFen: 'not a fen', moves: [{ from: 'e2', to: 'e5' }], ply: 0 })));
  await page.reload();
  await expect(page.locator('#board img')).toHaveCount(32);
  await expect(page.locator('#fenInput')).toHaveValue(start);
  await expect(page.locator('#moveList .move-san')).toHaveCount(0);
});

test('position analysis draws arrows for the top moves when the coach is off', async ({ page }) => {
  await load(page);
  await page.route('**/api/analyze/position', route => route.fulfill({ json: {
    bestEvalCp: 30,
    topMoves: [{ uci: 'e2e4', evalCp: 30, pv: 'e2e4' }, { uci: 'd2d4', evalCp: 25, pv: 'd2d4' }, { uci: 'g1f3', evalCp: 20, pv: 'g1f3' }]
  } }));
  await page.locator('#analyzePositionBtn').click();
  await expect(page.locator('#boardArrowOverlay path')).toHaveCount(3);
  // The best move is drawn last so it sits on top of the others.
  await expect(page.locator('#boardArrowOverlay path').last()).toHaveClass('coach-arrow-path');
  await drag(page, 'e2', 'e4');
  await expect(page.locator('#boardArrowOverlay path')).toHaveCount(0);
});

test('recent games can be imported by username and loaded for review', async ({ page }) => {
  await load(page);
  const game = { variant: 'standard', pgn: '[White "alice"]\n[Black "bob"]\n[Result "1-0"]\n[UTCDate "2026.09.20"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0' };
  let requested = '';
  await page.route('https://lichess.org/api/games/user/**', route => {
    requested = route.request().url();
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/x-ndjson', body: `${JSON.stringify(game)}\n` });
  });
  await page.locator('[data-tab="game-review"]').click();
  await page.getByRole('textbox', { name: 'Username' }).fill('alice');
  await page.getByRole('textbox', { name: 'Username' }).press('Enter');
  const result = page.getByRole('button', { name: /alice vs bob/ });
  await expect(result).toContainText('1-0 · 2026-09-20');
  expect(requested).toContain('/api/games/user/alice?max=10');
  await result.click();
  await expect(page.locator('#pgnInput')).toHaveValue(game.pgn);
  await expect(page.locator('#analyzeGameBtn')).toBeFocused();

  await page.route('https://lichess.org/api/games/user/**', route => route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await page.locator('#importGamesBtn').click();
  await expect(page.locator('#importStatus')).toContainText('rate limiting');
  await expect(page.locator('#importResults')).toBeHidden();
});

test('returning to the latest position resumes a cancelled sparring reply', async ({ page }) => {
  await load(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/analyze/position', async route => {
    requests += 1;
    if (requests === 1) await gate;
    await route.fulfill({ json: { topMoves: [{ uci: 'e7e5' }], bestEvalCp: 0 } }).catch(() => {});
  });
  await page.locator('.sparring-toggle-label').click();
  await drag(page, 'e2', 'e4');
  await expect.poll(() => requests).toBe(1);
  await page.locator('#moveNavEnd').click();
  await expect(page.locator('#fenInput')).toHaveValue(/4p3\/4P3.* w /);
  expect(requests).toBe(2);
  release();
  await expect(page.locator('#moveList .move-san')).toHaveText(['e4', 'e5']);
});

test('an incomplete explorer stream reports an error and permits retry', async ({ page }) => {
  await load(page);
  await page.route('**/api/analyze/all-moves', route => route.fulfill({
    contentType: 'text/event-stream', body: 'data: {"type":"partial","progress":0.05}\n\n'
  }));
  await page.locator('[data-tab="explorer"]').click();
  await page.locator('#analyzeAllMovesBtn').click();
  await expect(page.locator('#allMovesTable')).toContainText('stream ended before analysis finished');
  await expect(page.locator('#explorerProgress')).toBeHidden();
  await page.unroute('**/api/analyze/all-moves');
  await page.locator('#analyzeAllMovesBtn').click();
  await expect(page.locator('#engineStatus')).toContainText('Explorer complete', { timeout: 20000 });
});

test('copy feedback waits for clipboard success and exposes failures', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    window.copiedValues = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => new Promise((resolve, reject) => { window.finishCopy = success => {
        if (success) { window.copiedValues.push(text); resolve(); }
        else reject(new Error('Denied'));
      }; })
    } });
  });
  for (const id of ['copyFenBtn', 'copyPgnBtn']) {
    await page.locator(`#${id}`).click();
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('title', 'Copied');
    await page.evaluate(() => window.finishCopy(false));
    await expect(page.locator('#copyStatus')).toContainText('Copy failed');
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('title', 'Copied');
    await page.locator(`#${id}`).click();
    await page.evaluate(() => window.finishCopy(true));
    await expect(page.locator(`#${id}`)).toHaveAttribute('title', 'Copied');
  }
  const values = await page.evaluate(() => window.copiedValues);
  expect(values[0]).toBe(start);
  expect(values[1]).toContain('[Event "PawnForge analysis"]');
});

test('invalid positions never replace the board and every engine endpoint rejects them', async ({ page, request }) => {
  await load(page);
  const fen = '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1';
  await page.locator('#fenInput').fill(fen);
  await page.locator('#loadFenBtn').click();
  await expect(page.locator('#fenError')).toContainText('cannot leave its king in check');
  await expect(page.locator('#board img')).toHaveCount(32);
  for (const endpoint of ['position', 'all-moves', 'game']) {
    const response = await request.post(`/api/analyze/${endpoint}`, { data: { fen, fenSequence: [fen] } });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('Invalid FEN');
  }
  await page.locator('#analyzePositionBtn').click();
  await expect(page.locator('.pv-line').first()).toBeVisible();
});

test('superseded analysis and disabled coach requests are aborted', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.abortedSearches = 0;
    window.fetch = (url, options) => {
      if (url === '/api/analyze/position') options?.signal?.addEventListener('abort', () => { window.abortedSearches += 1; });
      return original(url, options);
    };
  });
  await load(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/analyze/position', async route => {
    requests += 1;
    await gate;
    await route.fulfill({ json: { topMoves: [{ uci: 'e2e4', evalCp: 20, pv: 'e2e4' }], bestEvalCp: 20 } }).catch(() => {});
  });
  await page.locator('#analyzePositionBtn').click();
  await expect.poll(() => requests).toBe(1);
  await page.locator('#analyzePositionBtn').click();
  await expect.poll(() => requests).toBe(2);
  await expect.poll(() => page.evaluate(() => window.abortedSearches)).toBe(1);
  await page.locator('#resetBtn').click();
  await expect.poll(() => page.evaluate(() => window.abortedSearches)).toBe(2);
  await page.locator('.coach-toggle-label').click();
  await expect.poll(() => requests).toBe(3);
  await page.locator('.coach-toggle-label').click();
  await expect.poll(() => page.evaluate(() => window.abortedSearches)).toBe(3);
  release();
  await expect(page.locator('#coachCard')).toBeHidden();
  await expect(page.locator('.pv-line')).toHaveCount(0);
});
