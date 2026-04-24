import path from 'node:path';
import { defineConfig } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const origin = path.join(root, 'build/release/avs_origin');

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  retries: 0,
  reporter: [['list']],
  use: {
    // Playwright's bundled Chromium has no H.264 decoder; use the installed Google Chrome.
    channel: process.env['AVS_BROWSER_CHANNEL'] ?? 'chrome',
    headless: true,
  },
  webServer: [
    {
      command: `${origin} --host 127.0.0.1 --port 18080 --root ${path.join(root, 'media')} --trace-dir ${path.join(root, 'traces')}`,
      url: 'http://127.0.0.1:18080/healthz',
      reuseExistingServer: false,
    },
    {
      command: `${origin} --host 127.0.0.1 --port 18083 --root ${path.join(root, 'apps/player/dist')}`,
      url: 'http://127.0.0.1:18083/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'npx tsx services/collector/src/main.ts',
      cwd: root,
      env: { SINK: 'memory', PORT: '18081', ARMS: 'A,B' },
      url: 'http://127.0.0.1:18081/healthz',
      reuseExistingServer: false,
    },
  ],
});
