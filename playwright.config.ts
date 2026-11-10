import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  // These hit the real local API (OpenAI costs); run them explicitly, e.g. `npm run test:smoke`.
  testIgnore: process.env['SMOKE'] ? [] : ['smoke.spec.ts', 'marketing-shots.spec.ts', 'store-assets.spec.ts', 'debug.spec.ts'],
  timeout: 60000,
  // One worker: every test shares the mock server on a fixed port.
  workers: 1,
  reporter: 'list',
});
