import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({ ...base, workers: 1, outputDir: '/tmp/terno-chip-results', use: { ...base.use, launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=localhost;127.0.0.1;[::1]'] } }, webServer: { command: 'VITE_RENDER_PROBE=1 pnpm vite --host 127.0.0.1 --port 57650 --strictPort', url: 'http://127.0.0.1:57650', reuseExistingServer: false, timeout: 120000 } });
