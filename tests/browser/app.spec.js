import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
async function load(page) {
  await page.route('https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm', r => r.fulfill({ headers: { 'access-control-allow-origin': '*' }, path: 'node_modules/chess.js/dist/esm/chess.js', contentType: 'text/javascript' }));
  await page.route('https://code.jquery.com/**', r => r.fulfill({ headers: { 'access-control-allow-origin': '*' }, path: 'node_modules/jquery/dist/jquery.min.js', contentType: 'text/javascript' }));
  await page.route('https://unpkg.com/**', r => r.fulfill({ headers: { 'access-control-allow-origin': '*' }, path: r.request().url().endsWith('.css') ? 'node_modules/@chrisoakman/chessboardjs/dist/chessboard-1.0.0.min.css' : 'node_modules/@chrisoakman/chessboardjs/dist/chessboard-1.0.0.min.js', contentType: r.request().url().endsWith('.css') ? 'text/css' : 'text/javascript' }));
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
  await expect(page.locator('#pawnforge-hud-msg')).toContainText('Paste a full FEN');
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
