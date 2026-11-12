import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Chrome Web Store / website screenshots (1280x800) against the real local stack
// (rewordly-web on :3000 + OpenAI). Not part of CI: `SMOKE=1 npx playwright test marketing-shots.spec.ts`.
const EXT = resolve(__dirname, '../../dist');
const OUT = process.env['SHOTS'] ?? resolve(__dirname, '../../store-assets');

const marks = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelector('rewordly-live')?.shadowRoot?.querySelectorAll('.mark.on') ?? []).map((m) => {
      const r = m.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })
  );

const cardText = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('rewordly-live')?.shadowRoot?.querySelector('.card') as HTMLElement | null;
    return card && !card.hidden ? card.textContent ?? '' : '';
  });

async function replaceText(page: Page, text: string): Promise<void> {
  await page.click('#playground');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 8 });
}

test('store screenshots', async () => {
  test.setTimeout(180000);
  mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  if (ctx.serviceWorkers().length === 0) await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/try');

  // 1. Mistakes underlined as you type, with the suggestion card.
  await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(800);
  await page.mouse.move(900, 760);
  await page.screenshot({ path: `${OUT}/1-underlines.png` });
  const [first] = await marks(page);
  await page.mouse.move(first!.x, first!.y);
  await expect.poll(() => cardText(page)).toContain('→');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/2-suggestion-card.png` });

  // 2. Any language: Turkish and German sentences, each checked in its own language.
  await page.mouse.move(900, 760);
  await replaceText(page, 'Sunumu bitirdim, akşam sana gönderecegim.\nYarın erken çıkmak istiyorm, toplantıyı öğlene alabilir miyiz?\nDas Projekt ist fast fertig und ich schike dir morgen die Datei.');
  await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(800);
  const [tr] = await marks(page);
  await page.mouse.move(tr!.x, tr!.y);
  await expect.poll(() => cardText(page)).toContain('→');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3-any-language.png` });

  // 3. AI rewrite of a selected sentence.
  await page.mouse.move(900, 760);
  await replaceText(page, 'hey, just wanted to say the report is kinda late, sorry about that, will send it soon');
  await page.waitForTimeout(2500);
  // Select the way a user would, so the extension sees a real selection.
  const box = (await page.locator('#playground').boundingBox())!;
  await page.mouse.move(box.x + 17, box.y + 31);
  await page.mouse.down();
  await page.mouse.move(box.x + 610, box.y + 31, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.locator('.rewordly-rewrite-part').click({ timeout: 10000 });
  await page.locator('.rewordly-modal.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/4-rewrite.png` });

  await ctx.close();
});
