import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

/** Shared by the store-asset and changelog-GIF generators (test/e2e/store-assets.spec.ts). */
export const ROOT = resolve(__dirname, '../..');
export const EXT = resolve(ROOT, 'dist');
export const PORT = 4790;
export const ORIGIN = `http://localhost:${PORT}`;
export const GENERATED = resolve(__dirname, 'generated');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

/** Serves the scene pages, the extension logo and whatever the generators wrote to generated/. */
export function startStaticServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = path === '/logo.png' ? join(ROOT, 'icons/icon128.png') : join(__dirname, path);
    if (!file.startsWith(__dirname) && file !== join(ROOT, 'icons/icon128.png')) return void res.writeHead(403).end();
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

/** Chromium with the built (dev) extension loaded. Needs the web app on :3000 for real results. */
export async function launch(viewport: { width: number; height: number }, deviceScaleFactor: number): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport,
    deviceScaleFactor,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  if (ctx.serviceWorkers().length === 0) await ctx.waitForEvent('serviceworker');
  return ctx;
}

export const extensionId = (ctx: BrowserContext): string => new URL(ctx.serviceWorkers()[0]!.url()).host;

/** Underlines drawn by the extension, as viewport rects. */
export const marks = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelector('rewordly-live')?.shadowRoot?.querySelectorAll('.mark.on') ?? [])
      .map((m) => m.getBoundingClientRect())
      .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, width: r.width }))
      .sort((a, b) => a.y - b.y || a.x - b.x)
  );

/** What the open suggestion card says (empty when none is open). */
export const cardInfo = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('rewordly-live')?.shadowRoot?.querySelector('.card') as HTMLElement | null;
    if (!card || card.hidden) return null;
    const text = (sel: string) => card.querySelector(sel)?.textContent?.trim() ?? '';
    return { original: text('.from'), to: text('.to'), message: text('.msg') };
  });

/** Puts the caret at the end of the message body, which is what the extension checks on focus. */
export const focusBodyEnd = (page: Page) =>
  page.evaluate(() => {
    const body = document.getElementById('body')!;
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });

/**
 * The popup trimmed to what the store image talks about: the free allowance and the auto-check
 * switch. Only visibility is changed; every value shown is the real one.
 */
export const trimPopup = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const keep = new Set([document.getElementById('usageSection'), content.querySelector('.section-label'), content.querySelector('.toggle-section')]);
    for (const child of Array.from(content.children)) if (!keep.has(child as HTMLElement)) (child as HTMLElement).style.display = 'none';
    document.querySelectorAll('#usageRows > :nth-child(-n+4)').forEach((el) => ((el as HTMLElement).style.display = 'none'));
    document.querySelector('.toggle-section .toggle-container')!.setAttribute('style', 'display:none');
    const tone = document.getElementById('rewriteTone')!.closest('div');
    if (tone) (tone as HTMLElement).style.display = 'none';
    const second = document.querySelectorAll('.toggle-section .toggle-container')[1] as HTMLElement | undefined;
    if (second) second.style.marginTop = '0';
    // Two notes that only matter to someone reading the whole popup.
    for (const p of Array.from(document.querySelectorAll('p'))) {
      if (/^(Show rewrite and grammar|Anonymous limits)/.test(p.textContent ?? '')) p.style.display = 'none';
    }
    document.body.style.maxHeight = 'none';
    document.body.style.minHeight = '0';
  });

export async function openScene(ctx: BrowserContext, scene: number, cursor = false): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/scene.html?s=${scene}${cursor ? '&cursor=1' : ''}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Keeps the fake pointer above the extension's overlay (which is appended to <html> later). */
export const raiseCursor = (page: Page) =>
  page.evaluate(() => {
    const cursor = document.getElementById('cursor');
    if (cursor) document.documentElement.appendChild(cursor);
  });

/** Averages 2×2 pixel blocks: a sharp, anti-aliased half-size image from a 2× capture. */
function halve(src: PNG): PNG {
  const out = new PNG({ width: src.width >> 1, height: src.height >> 1 });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      for (let c = 0; c < 4; c++) {
        const at = (px: number, py: number) => src.data[((py * src.width) + px) * 4 + c]!;
        out.data[(y * out.width + x) * 4 + c] = Math.round((at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4);
      }
    }
  }
  return out;
}

export function readPng(buffer: Buffer, halved = false): PNG {
  const png = PNG.sync.read(buffer);
  return halved ? halve(png) : png;
}

/** 24-bit PNG without an alpha channel, as the Chrome Web Store asks for. */
export function writeOpaquePng(png: PNG, path: string): void {
  writeFileSync(path, PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true }));
}
