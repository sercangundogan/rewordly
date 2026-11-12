import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { PNG } from 'pngjs';
import { resolve } from 'node:path';
import { cardInfo, extensionId, focusBodyEnd, GENERATED, launch, marks, openScene, ORIGIN, raiseCursor, readPng, ROOT, startStaticServer, trimPopup, writeOpaquePng } from '../marketing/helpers';

// Chrome Web Store images, against the real local stack (rewordly-web on :3000 + OpenAI):
//   npm run build:dev && SMOKE=1 npx playwright test store-assets.spec.ts
// Output: store-assets/v1.8.0/ (1280x800 screenshots, 440x280 tile, 1400x560 marquee).
const OUT = process.env['SHOTS'] ?? resolve(__dirname, '../../store-assets/v1.8.0');

/** ONLY=3,4 renders just those scenes (1-5). */
const only = process.env['ONLY']?.split(',').map(Number);
const want = (scene: number) => !only || only.includes(scene);

async function shot(page: Page, name: string): Promise<void> {
  const buffer = await page.screenshot();
  writeOpaquePng(readPng(buffer), `${OUT}/${name}.png`);
}

// A click that can't land fails after 15 s instead of retrying until the test times out.
test.use({ actionTimeout: 15000 });

/** KIND=shots|tiles|gif renders only that part (default: all). */
const kind = process.env['KIND'];
const wants = (name: string) => !kind || kind.split(',').includes(name);

test('store screenshots', async () => {
  test.skip(!wants('shots'));
  test.setTimeout(Number(process.env['TIMEOUT']) || 300000);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(GENERATED, { recursive: true });
  const server = await startStaticServer();
  // 1024x640 CSS px at 1.25x = 1280x800, so everything (including the extension's UI) is a bit larger.
  const ctx = await launch({ width: 1024, height: 640 }, 1.25);
  try {
    // 5. The popup, captured first: scene 5 shows it.
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 384, height: 900 });
    // Captured at 2x: it is shown a little smaller than it is, and stays sharp.
    await (await ctx.newCDPSession(popup)).send('Emulation.setDeviceMetricsOverride', { width: 384, height: 900, deviceScaleFactor: 2, mobile: false });
    await popup.goto(`chrome-extension://${extensionId(ctx)}/popup.html`);
    await popup.evaluate(() => document.fonts.ready);
    await popup.waitForTimeout(2500);
    await trimPopup(popup);
    await popup.waitForTimeout(300);
    writeOpaquePng(readPng(await popup.locator('body').screenshot()), `${GENERATED}/popup.png`);
    await popup.close();

    let page: Page;
    // 1. Underlines as you type.
    if (want(1)) {
    page = await openScene(ctx, 1);
    await focusBodyEnd(page);
    await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(900);
    await page.mouse.move(1010, 630);
    await shot(page, '1-live-underlines');
    await page.close();
    }

    // 2. The suggestion card.
    if (want(2)) {
    page = await openScene(ctx, 2, true);
    await focusBodyEnd(page);
    await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(700);
    let target = (await marks(page))[0]!;
    for (const mark of await marks(page)) {
      await page.mouse.move(mark.x, mark.y, { steps: 4 });
      await page.waitForTimeout(350);
      const info = await cardInfo(page);
      if (info?.message) {
        target = mark;
        break;
      }
    }
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await expect.poll(() => cardInfo(page)).not.toBeNull();
    await page.waitForTimeout(500);
    await shot(page, '2-suggestion-card');
    writeOpaquePng(readPng(await page.screenshot({ clip: { x: 384, y: 44, width: 620, height: 540 } })), `${GENERATED}/window-card.png`);
    await page.close();
    }

    // 3. Any language.
    if (want(3)) {
    page = await openScene(ctx, 3, true);
    await focusBodyEnd(page);
    await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBeGreaterThanOrEqual(4);
    await page.waitForTimeout(700);
    let pick = (await marks(page))[3]!;
    for (const mark of await marks(page)) {
      await page.mouse.move(mark.x, mark.y, { steps: 3 });
      await page.waitForTimeout(300);
      if ((await cardInfo(page))?.original.startsWith('gönder')) pick = mark;
    }
    await page.mouse.move(pick.x, pick.y, { steps: 4 });
    await expect.poll(() => cardInfo(page)).not.toBeNull();
    await page.waitForTimeout(500);
    await shot(page, '3-any-language');
    await page.close();
    }

    // 4. Rewrite.
    if (want(4)) {
    page = await openScene(ctx, 4, true);
    await page.addStyleTag({
      content:
        'html .rewordly-modal{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;justify-content:flex-end!important;align-items:center!important;padding:0 20px 0 0!important}' +
        'html .rewordly-modal-content{width:660px!important;max-width:660px!important;max-height:none!important;zoom:.7!important}' +
        'html .rewordly-modal-body{max-height:none!important;overflow:visible!important}',
    });
    await page.locator('#pick').click({ clickCount: 3 });
    await page.waitForTimeout(700);
    await page.locator('.rewordly-rewrite-part').click({ timeout: 10000 });
    await page.locator('.rewordly-modal.show').waitFor({ timeout: 10000 });
    await page.waitForTimeout(7000);
    await shot(page, '4-rewrite');
    await page.close();
    }

    // 5. The popup.
    if (want(5)) {
    page = await openScene(ctx, 5);
    await page.waitForTimeout(400);
    await shot(page, '5-free-to-start');
    await page.close();
    }
  } finally {
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 8000))]);
    server.close();
  }
});

test('promo tiles', async () => {
  test.skip(!wants('tiles'));
  test.setTimeout(120000);
  mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const browser = await chromium.launch();
  try {
    // Rendered at 2x and averaged down: sharp text at the exact sizes the store asks for.
    for (const [t, name, width, height] of [['tile', 'tile-440x280', 440, 280], ['marquee', 'marquee-1400x560', 1400, 560]] as const) {
      const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })).newPage();
      await page.goto(`${ORIGIN}/tiles.html?t=${t}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      writeOpaquePng(readPng(await page.screenshot(), true), `${OUT}/${name}.png`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test('changelog gif', async () => {
  test.skip(!wants('gif'));
  test.setTimeout(240000);
  const server = await startStaticServer();
  const ctx = await launch({ width: 640, height: 360 }, 2);
  const raw: Array<{ ts: number; data: Buffer }> = [];
  try {
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/gif.html`);
    await page.evaluate(() => document.fonts.ready);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const caption = (text: string) => page.evaluate((t) => (window as unknown as { setCaption(t: string): void }).setCaption(t), text);
    const center = (selector: string) =>
      page.evaluate((sel) => {
        const r = document.querySelector('rewordly-live')!.shadowRoot!.querySelector(sel)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, selector);

    // Chrome's own screencast: a frame whenever the screen changes, with a timestamp. Real-time
    // typing, pointer movement and the underline animation come out at their true speed.
    const cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', (e) => {
      raw.push({ ts: e.metadata.timestamp ?? Date.now() / 1000, data: Buffer.from(e.data, 'base64') });
      void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
    });

    let at = { x: 560, y: 250 };
    await page.mouse.move(at.x, at.y);
    await raiseCursor(page);
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });

    /** Eased pointer movement at about 60 steps a second. */
    const glide = async (to: { x: number; y: number }, ms: number) => {
      const from = at;
      const started = Date.now();
      for (let t = 0; t < 1; ) {
        t = Math.min(1, (Date.now() - started) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
        await sleep(12);
      }
      at = to;
    };

    await caption('Mistakes are underlined as you type');
    await sleep(500);
    await page.locator('#body').click({ position: { x: 200, y: 20 } });
    await sleep(600);
    await page.keyboard.type('I dont think their is enough time befor the deadline.', { delay: 42 });
    await expect.poll(async () => (await marks(page)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(3);
    await sleep(800);

    await caption('Hover to see the fix');
    const first = (await marks(page))[0]!;
    await glide({ x: first.x, y: first.y }, 650);
    await expect.poll(() => cardInfo(page)).not.toBeNull();
    await sleep(1000);

    await caption('One click applies it');
    await glide(await center('.card .to'), 450);
    await sleep(250);
    await page.mouse.click(at.x, at.y);
    await sleep(700);

    await caption('Or fix everything at once');
    await glide(await center('.badge.on'), 650);
    await sleep(200);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => cardInfo(page)).not.toBeNull();
    await sleep(800);
    await glide(await center('.card .all'), 450);
    await sleep(250);
    await page.mouse.click(at.x, at.y);
    await sleep(700);
    await caption('Free to try. Works on almost every site.');
    await glide({ x: 540, y: 330 }, 500);
    await sleep(500);
    await cdp.send('Page.stopScreencast');
    await sleep(200);
  } finally {
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 8000))]);
    server.close();
  }

  // Frames closer than 25 ms apart add size, not smoothness: keep one, and always the last.
  raw.sort((a, b) => a.ts - b.ts);
  const kept = raw.filter((f, i) => i === raw.length - 1 || i === 0 || f.ts - (raw[i - 1]?.ts ?? 0) >= 0.025);
  const frames = kept.map((f, i) => ({
    png: readPng(f.data, true),
    // GIF delays are in 10 ms steps and browsers treat anything under 20 ms as slow: stay above it.
    delay: i === kept.length - 1 ? 2600 : Math.min(1500, Math.max(30, Math.round((kept[i + 1]!.ts - f.ts) * 1000))),
  }));
  const { width, height } = frames[0]!.png;

  // One shared palette (no colour flicker) with a spare entry for "unchanged".
  const sample = Buffer.concat(frames.filter((_, i) => i % 6 === 0).map((f) => f.png.data));
  const colours = quantize(new Uint8Array(sample), 127);
  const palette = [...colours, [0, 0, 0]];
  const clear = palette.length - 1;
  const gif = GIFEncoder();
  let previous: Uint8Array | null = null;
  frames.forEach((f, i) => {
    const full = applyPalette(new Uint8Array(f.png.data), colours);
    // Only what changed since the last frame is drawn: the rest is transparent.
    const out = previous ? full.map((v, p) => (v === previous![p] ? clear : v)) : full;
    previous = full;
    gif.writeFrame(out, width, height, { palette: i === 0 ? palette : undefined, delay: f.delay, repeat: 0, transparent: i > 0, transparentIndex: clear, dispose: 1 });
  });
  gif.finish();
  const file = resolve(ROOT, 'assets/live-check.gif');
  mkdirSync(resolve(ROOT, 'assets'), { recursive: true });
  writeFileSync(file, gif.bytes());

  // A contact sheet of six frames, to check the result without playing it.
  const picks = [0.05, 0.25, 0.4, 0.55, 0.75, 1].map((q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]!.png);
  const sheet = new PNG({ width: width * 3, height: height * 2 });
  picks.forEach((png, n) => PNG.bitblt(png, sheet, 0, 0, width, height, (n % 3) * width, Math.floor(n / 3) * height));
  writeOpaquePng(sheet, `${GENERATED}/gif-contact.png`);
  const total = frames.reduce((sum, f) => sum + f.delay, 0);
  const moving = frames.filter((f) => f.delay <= 120).map((f) => f.delay);
  console.log(`frames in motion (delay <= 120 ms): ${moving.length}, median delay ${[...moving].sort((a, b) => a - b)[Math.floor(moving.length / 2)]} ms`);
  console.log(`live-check.gif: ${frames.length} frames, ${(total / 1000).toFixed(1)} s, ${(frames.length / (total / 1000)).toFixed(0)} frames/s on average, ${Math.round(statSync(file).size / 1024)} KB`);
});
