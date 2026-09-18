import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';

test('unpacked extension relays foreign-page FEN analysis to the local API', async () => {
  const extension = resolve('.');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = await context.newPage();
    await page.route('https://chess.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><h1>Analysis fixture</h1><input id="fenInput" value="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"></body></html>` }));
    await page.goto('https://chess.example.test/');
    await expect(page.locator('#pawnforge-hud')).toBeVisible();
    await page.locator('#pawnforge-endpoint').fill('http://127.0.0.1:4189/api/analyze/position');
    await page.locator('#pawnforge-save-endpoint').click();
    await expect(page.locator('#pawnforge-hud-candidates button').first()).toBeVisible({ timeout: 25000 });
    await page.locator('#pawnforge-endpoint').fill('https://example.org/api/analyze/position');
    await page.locator('#pawnforge-save-endpoint').click();
    await expect(page.locator('#pawnforge-hud-msg')).toContainText('Use http://127.0.0.1:PORT');
  } finally { await context.close(); }
});
