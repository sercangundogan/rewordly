import { test, chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer } from './server';

// Manual smoke test against the real local API (rewordly-web on :3000 + OpenAI). Not part of CI.
const EXT = resolve(__dirname, '../../dist');
const SHOT = process.env['SMOKE_SCREENSHOT'] ?? 'smoke.png';

test('real API smoke', async () => {
  test.setTimeout(90000);
  const server = await startServer(4777);
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 820, height: 420 },
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  if (ctx.serviceWorkers().length === 0) await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto('http://localhost:4777');
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.click('#ta');
  await page.keyboard.type('She dont like apples, and they goes to school everyday.\nBugün hava çok guzel ve ben dışarı çıkmak istiyorm.', { delay: 15 });
  await page.waitForFunction(() => (document.querySelector('rewordly-live')?.shadowRoot?.querySelectorAll('.mark.on').length ?? 0) >= 3, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const issues = await page.evaluate(() => Array.from(document.querySelector('rewordly-live')!.shadowRoot!.querySelectorAll('.mark.on')).length);
  const box = await page.evaluate(() => {
    const r = document.querySelector('rewordly-live')!.shadowRoot!.querySelector('.mark.on')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(600);
  const card = await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector('.card')!.textContent);
  console.log(`marks=${issues} card=${card}`);
  await page.screenshot({ path: SHOT, clip: { x: 0, y: 0, width: 820, height: 260 } });
  await ctx.close();
  server.close();
});
