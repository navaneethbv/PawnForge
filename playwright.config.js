import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4189', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node server.js', env: { PORT: '4189' }, url: 'http://127.0.0.1:4189', reuseExistingServer: false },
});
