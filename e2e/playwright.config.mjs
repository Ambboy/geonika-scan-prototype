import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: '**/*.spec.mjs',
  fullyParallel: false, workers: 1, retries: 0,
  timeout: 90000, expect: { timeout: 15000 },
  reporter: [['list']],
  outputDir: process.env.SCAN_EVIDENCE_DIR ? `${process.env.SCAN_EVIDENCE_DIR}/playwright` : 'test-results/scan-tour',
  use: {
    baseURL: 'http://127.0.0.1:4178/geonika-scan-prototype/',
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: process.env.SCAN_BROWSER_EXECUTABLE || undefined, chromiumSandbox: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4178 --strictPort --base /geonika-scan-prototype/',
    url: 'http://127.0.0.1:4178/geonika-scan-prototype/',
    reuseExistingServer: false, timeout: 20000,
  },
});
