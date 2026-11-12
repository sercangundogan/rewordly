import { test as base, expect, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startServer, stats } from './server';

const PORT = 4777;
const ORIGIN = `http://localhost:${PORT}`;
const EXT_DIR = resolve(__dirname, '../../.e2e-dist');
const SENTENCE = 'I dont know teh answer.';
/** On macOS, End only scrolls a contenteditable; Cmd+Right moves the caret to the end of the line. */
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

interface Mark {
  left: number;
  top: number;
  width: number;
  height: number;
}

const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({}, use) => {
    // Extensions only load in Chromium's "new" headless mode, which Playwright 1.48 doesn't pick by itself.
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: ['--headless=new', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    // Wait for the background worker so the extension is fully loaded.
    if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto(ORIGIN);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    await use(page);
  },
});

let server: { close(): void };

test.beforeAll(async () => {
  execSync('npx webpack --mode=development', {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, REWORDLY_OUT_DIR: '.e2e-dist', DEV_API_BASE_URL: ORIGIN, USAGE_FLUSH_MS: '500' },
    stdio: 'ignore',
  });
  server = await startServer(PORT);
});

test.afterAll(() => server?.close());

test.beforeEach(() => {
  stats.limitAfter = Infinity;
  stats.feedback = [];
  stats.chars = 0;
  stats.texts = [];
  stats.failAll = false;
  stats.failures = 0;
  stats.latencyMs = 250;
  stats.quota = null;
});

/** Visible underline rects in a frame's overlay. */
async function marks(frame: Page | Frame): Promise<Mark[]> {
  return frame.evaluate(() => {
    // The page-level overlay plus anchors inside scroll areas.
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    return roots.flatMap((root) => Array.from(root?.querySelectorAll('.mark.on') ?? [])).map((m) => {
      const r = m.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
  });
}

async function waitForMarks(frame: Page | Frame, count: number): Promise<Mark[]> {
  await expect.poll(async () => (await marks(frame)).length, { timeout: 10000 }).toBe(count);
  // Let the fade-in transition finish so rects are final.
  await new Promise((r) => setTimeout(r, 250));
  return (await marks(frame)).sort((a, b) => a.top - b.top || a.left - b.left);
}

async function cardText(frame: Page | Frame): Promise<string> {
  return frame.evaluate(() => {
    const card = document.querySelector('rewordly-live')?.shadowRoot?.querySelector('.card');
    return card && !(card as HTMLElement).hidden ? card.textContent ?? '' : '';
  });
}

/** Hovers the underline (pointer events pass through to the field) and clicks the suggestion. */
async function applyFirstSuggestion(page: Page, mark: Mark, word = 'dont', frameOffset = { x: 0, y: 0 }): Promise<void> {
  await page.mouse.move(frameOffset.x + mark.left + mark.width / 2, frameOffset.y + mark.top + mark.height / 2);
  const frame = frameOffset.x || frameOffset.y ? page.frames()[1]! : page;
  // The card switches to the hovered word after a short hover delay.
  await expect.poll(() => cardText(frame)).toContain(`${word}→`);
  await frame.evaluate(() => {
    const button = document.querySelector('rewordly-live')?.shadowRoot?.querySelector<HTMLButtonElement>('.card .to');
    button?.click();
  });
}

test('textarea: underlines align with the words, apply keeps undo', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [dont, teh] = await waitForMarks(page, 2);

  // Clicking the centre of each underline must put the caret inside that word.
  for (const [mark, word] of [[dont!, 'dont'], [teh!, 'teh']] as const) {
    await page.mouse.click(mark.left + mark.width / 2, mark.top + mark.height / 2);
    const caret = await page.$eval('#ta', (el) => (el as HTMLTextAreaElement).selectionStart);
    const start = SENTENCE.indexOf(word);
    expect(caret).toBeGreaterThanOrEqual(start);
    expect(caret).toBeLessThanOrEqual(start + word.length);
  }

  await applyFirstSuggestion(page, dont!);
  await expect(page.locator('#ta')).toHaveValue("I don't know teh answer.");
  await waitForMarks(page, 1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#ta')).toHaveValue(SENTENCE);
});

test('textarea: underlines follow the text while typing before them', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [before] = await waitForMarks(page, 2);
  const requests = stats.checks;

  await page.$eval('#ta', (el) => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.keyboard.type('Well, ');
  // Shifted locally right away: well within the typing debounce, so no new check has answered yet.
  await expect
    .poll(async () => Math.min(...(await marks(page)).map((m) => m.left)), { timeout: 500, intervals: [16] })
    .toBeGreaterThan(before!.left + 20);
  const [after] = (await marks(page)).sort((a, b) => a.left - b.left);
  await page.mouse.click(after!.left + after!.width / 2, after!.top + after!.height / 2);
  const caret = await page.$eval('#ta', (el) => (el as HTMLTextAreaElement).selectionStart);
  expect(caret).toBeGreaterThanOrEqual('Well, I '.length);
  expect(caret).toBeLessThanOrEqual('Well, I dont'.length);
  expect(stats.checks).toBeGreaterThanOrEqual(requests);
});

test('input: underline + apply', async ({ page }) => {
  await page.click('#inp');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await expect(page.locator('#inp')).toHaveValue("I don't know teh answer.");
});

test('contenteditable: underline matches the word rect, apply edits in place', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  const word = await page.$eval('#ce', (el) => {
    const node = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, node.data.indexOf('dont'));
    range.setEnd(node, node.data.indexOf('dont') + 4);
    const r = range.getBoundingClientRect();
    return { left: r.left, width: r.width, bottom: r.bottom };
  });
  expect(Math.abs(dont!.left - word.left)).toBeLessThan(2);
  expect(Math.abs(dont!.width - word.width)).toBeLessThan(2);
  expect(Math.abs(dont!.top + dont!.height - word.bottom)).toBeLessThan(3);

  await applyFirstSuggestion(page, dont!);
  await expect(page.locator('#ce')).toHaveText("I don't know teh answer.");
});

test('React controlled textarea updates React state', async ({ page }) => {
  await page.click('#react-ta');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __reactValue: string }).__reactValue)).toBe(
    "I don't know teh answer."
  );
});

test('Quill: apply goes through the editor model', async ({ page }) => {
  await page.click('#quill .ql-editor');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __quill: { getText(): string } }).__quill.getText().trim()))
    .toBe("I don't know teh answer.");
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(' ok');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __quill: { getText(): string } }).__quill.getText().trim()))
    .toBe("I don't know teh answer. ok");
});

test('Quill 1.x with data-gramm="false" (Slack): checked, and apply goes through the editor model', async ({ page }) => {
  await page.click('#quill1 .ql-editor');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  const text = () => page.evaluate(() => (window as unknown as { __quill1: { getText(): string } }).__quill1.getText().trim());
  await applyFirstSuggestion(page, dont!);
  await expect.poll(text).toBe("I don't know teh answer.");
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(' ok');
  await expect.poll(text).toBe("I don't know teh answer. ok");
});

test('TipTap/ProseMirror: apply goes through the editor model', async ({ page }) => {
  await page.click('#tiptap .ProseMirror');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __tiptap: { getText(): string } }).__tiptap.getText()))
    .toBe("I don't know teh answer.");
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(' ok');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __tiptap: { getText(): string } }).__tiptap.getText()))
    .toBe("I don't know teh answer. ok");
});

test('open shadow DOM editor', async ({ page }) => {
  await page.locator('#shadow').locator('#inner').click();
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await expect(page.locator('#shadow').locator('#inner')).toHaveText("I don't know teh answer.");
});

test('iframe textarea', async ({ page }) => {
  const frame = page.frames().find((f) => f.url().startsWith('about:srcdoc'))!;
  await frame.click('#inner');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(frame, 2);
  const box = (await page.locator('#frame').boundingBox())!;
  await applyFirstSuggestion(page, dont!, 'dont', { x: box.x, y: box.y });
  await expect(frame.locator('#inner')).toHaveValue("I don't know teh answer.");
});

test('excluded fields are never checked', async ({ page }) => {
  const before = stats.paragraphs;
  for (const selector of ['#email', '#nospell', '#code', '#notion-code', '#medium-search', '#site-search', '#date-picker', '#pw-shown', '#token-box']) {
    await page.click(selector);
    await page.keyboard.type(selector === '#email' ? 'teh@example.com' : SENTENCE);
  }
  await new Promise((r) => setTimeout(r, 1500));
  expect(await marks(page)).toHaveLength(0);
  expect(await badgeText(page)).toBe('');
  expect(stats.paragraphs).toBe(before);
});

test('unchanged text is served from cache', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  const requests = stats.checks;
  // Same paragraph in another field: no new request.
  await page.click('#inp');
  await page.keyboard.insertText(SENTENCE);
  await waitForMarks(page, 4);
  expect(stats.checks).toBe(requests);
});

test('scrolling a textarea moves its underlines and hides scrolled-out ones', async ({ page }) => {
  await page.click('#ta-scroll');
  await page.keyboard.insertText(`${SENTENCE}\n${'Fine line.\n'.repeat(12)}`);
  // insertText leaves the caret (and the scroll position) at the end.
  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 0));
  const [first] = await waitForMarks(page, 2);

  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 6));
  await expect.poll(async () => (await marks(page))[0]?.top).toBeCloseTo(first!.top - 6, 0);

  // Scrolled out of view: not drawn at all (nothing to clip, nothing to hover).
  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 60));
  await expect.poll(async () => (await marks(page)).length).toBe(0);

  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 0));
  await expect.poll(async () => (await marks(page)).length).toBe(2);
});

test('daily limit shows the limit card and stops requests', async ({ page }) => {
  stats.limitAfter = stats.checks;
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await expect.poll(() => cardText(page), { timeout: 10000 }).toContain('free trial is over');
  const requests = stats.checks;
  await page.keyboard.type(' More words here.');
  await new Promise((r) => setTimeout(r, 1500));
  expect(stats.checks).toBe(requests);
});

// --- Editors with their own document model (Medium = Slate, X = Draft.js, Reddit = Lexical) ---
// The DOM changing is not enough here: the editor's MODEL must change, or the next keystroke
// re-renders the old text. So every assertion reads the model.

const MODEL_EDITORS = [
  { name: 'slate', selector: '#slate' },
  { name: 'draft', selector: '#draft-root [contenteditable]' },
  { name: 'lexical', selector: '#lexical' },
] as const;

for (const editor of MODEL_EDITORS) {
  test(`${editor.name}: fixes reach the editor model and survive further typing`, async ({ page }) => {
    await page.goto(`${ORIGIN}/model-editors.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    const modelText = () =>
      page.evaluate((name) => (window as unknown as { __text: Record<string, () => string> }).__text[name]!(), editor.name);

    await page.click(editor.selector);
    await page.keyboard.type(SENTENCE);
    await expect.poll(modelText).toBe(SENTENCE);
    const [dont] = await waitForMarks(page, 2);

    await applyFirstSuggestion(page, dont!);
    await expect.poll(modelText).toBe("I don't know teh answer.");

    // Keep typing: a DOM-only change would be reverted by the editor's re-render here.
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(' ok');
    await expect.poll(modelText).toBe("I don't know teh answer. ok");
    await expect(page.locator(editor.selector)).toHaveText("I don't know teh answer. ok");

    const [teh] = await waitForMarks(page, 1);
    await applyFirstSuggestion(page, teh!, 'teh');
    await expect.poll(modelText).toBe("I don't know the answer. ok");
    await page.keyboard.press(LINE_END);
    await page.keyboard.type('!');
    await expect.poll(modelText).toBe("I don't know the answer. ok!");
  });
}

for (const editor of MODEL_EDITORS) {
  test(`${editor.name}: a deletion removes exactly the flagged text`, async ({ page }) => {
    await page.goto(`${ORIGIN}/model-editors.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    const modelText = () =>
      page.evaluate((name) => (window as unknown as { __text: Record<string, () => string> }).__text[name]!(), editor.name);

    await page.click(editor.selector);
    await page.keyboard.type('It manages permissions and controls. asd');
    const [asd] = await waitForMarks(page, 1);
    await applyFirstSuggestion(page, asd!, 'asd');
    await expect.poll(modelText).toBe('It manages permissions and controls.');
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(' Done.');
    await expect.poll(modelText).toBe('It manages permissions and controls. Done.');
  });
}

for (const field of [
  { selector: '#ta', value: (p: Page) => p.$eval('#ta', (el) => (el as HTMLTextAreaElement).value) },
  { selector: '#inp', value: (p: Page) => p.$eval('#inp', (el) => (el as HTMLInputElement).value) },
  { selector: '#ce', value: (p: Page) => p.$eval('#ce', (el) => el.textContent ?? '') },
]) {
  test(`${field.selector}: a deletion removes exactly the flagged text`, async ({ page }) => {
    await page.click(field.selector);
    await page.keyboard.type('It manages permissions and controls. asd');
    const [asd] = await waitForMarks(page, 1);
    await applyFirstSuggestion(page, asd!, 'asd');
    await expect.poll(() => field.value(page)).toBe('It manages permissions and controls.');
  });
}

// --- Cost control ---

test('the sentence being typed waits until it is finished or the user pauses', async ({ page }) => {
  await page.click('#ta');
  const before = stats.checks;
  await page.keyboard.type('I dont know teh answer');
  // Unfinished and recently typed: nothing is sent yet.
  await new Promise((r) => setTimeout(r, 1200));
  expect(stats.checks).toBe(before);
  // After an idle pause it is checked anyway.
  await waitForMarks(page, 2);
  expect(stats.checks).toBe(before + 1);
});

test('only the edited sentence is sent again', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('First sentence is fine. I dont know teh answer.');
  await waitForMarks(page, 2);
  const paragraphs = stats.paragraphs;
  await page.keyboard.type(' A third sentence.');
  await expect.poll(() => stats.paragraphs).toBe(paragraphs + 1);
  await new Promise((r) => setTimeout(r, 1200));
  expect(stats.paragraphs).toBe(paragraphs + 1);
});

test('results survive a reload without new requests (persistent cache)', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  const requests = stats.checks;
  // Let the background worker persist the cache, then reload.
  await new Promise((r) => setTimeout(r, 2500));
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
  await page.click('#ta');
  await page.keyboard.insertText(SENTENCE);
  await waitForMarks(page, 2);
  expect(stats.checks).toBe(requests);
});

test('low quota shows a dot on the badge and a quiet note in the card', async ({ page }) => {
  stats.quota = { tier: 'anonymous', period: 'lifetime', used: 13500, limit: 15000 };
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await expect
    .poll(() => page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector('.badge.on')?.classList.contains('low')))
    .toBe(true);
  await page.mouse.move(dont!.left + dont!.width / 2, dont!.top + dont!.height / 2);
  await expect.poll(() => cardText(page)).toContain('10% of your free trial left');
  // Nothing opened by itself before the hover.
});

// --- Selection flow (floating Rewrite / Check Grammar button) ---

for (const action of ['rewrite', 'grammar'] as const) {
  test(`floating ${action} button opens the result and applies it`, async ({ page }) => {
    await page.click('#ta');
    await page.keyboard.insertText('the report is late, teh end');
    const box = (await page.locator('#ta').boundingBox())!;
    // Drag-select like a user (the button reacts to mouse selections).
    await page.mouse.move(box.x + 12, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 20, box.y + 20, { steps: 10 });
    await page.mouse.up();
    const button = page.locator(action === 'rewrite' ? '.rewordly-rewrite-part' : '.rewordly-grammar-part');
    await button.click({ timeout: 10000 });
    await expect(page.locator('.rewordly-modal.show')).toBeVisible();
    const expected = action === 'rewrite' ? 'Rewritten: the report is late, the end' : 'the report is late, the end';
    await expect(page.locator('.rewordly-rewritten-text')).toHaveText(expected);
    await page.locator('.rewordly-apply-btn').click();
    await expect(page.locator('#ta')).toHaveValue(expected);
  });
}

test('underlines and badge hide while something covers the field', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  // A site modal on top of the field.
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    Object.assign(cover.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.4)', zIndex: '1000' });
    document.body.appendChild(cover);
  });
  await expect.poll(async () => (await marks(page)).length).toBe(0);
  await page.evaluate(() => document.getElementById('cover')!.remove());
  // Uncovering doesn't fire any event on the field; the next render brings them back.
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await marks(page)).length).toBe(2);
});

for (const editor of MODEL_EDITORS) {
  test(`${editor.name}: fixing an earlier line doesn't touch the text at the caret`, async ({ page }) => {
    await page.goto(`${ORIGIN}/model-editors.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    const modelText = () =>
      page.evaluate((name) => (window as unknown as { __text: Record<string, () => string> }).__text[name]!(), editor.name);

    // Several blocks, mistake on the first line, caret left at the very end (like a real post).
    await page.click(editor.selector);
    await page.keyboard.type('I dont know the answer.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line is fine.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Thanks for reading.');
    const [dont] = await waitForMarks(page, 1);

    await applyFirstSuggestion(page, dont!);
    const expected = editor.name === 'lexical' || editor.name === 'slate'
      ? (t: string) => t.replace(/\n+/g, '\n')
      : (t: string) => t;
    await expect.poll(async () => expected(await modelText())).toBe(
      expected("I don't know the answer.\n\nSecond line is fine.\nThanks for reading.")
    );
  });
}

for (const editor of MODEL_EDITORS) {
  test(`${editor.name}: fix all across lines keeps the rest of the text`, async ({ page }) => {
    await page.goto(`${ORIGIN}/model-editors.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
    const modelText = () =>
      page.evaluate((name) => (window as unknown as { __text: Record<string, () => string> }).__text[name]!(), editor.name);

    await page.click(editor.selector);
    await page.keyboard.type('I dont know.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line is fine.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('This is teh end.');
    await waitForMarks(page, 2);
    await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.badge.on')!.click());
    await expect.poll(() => cardText(page)).toContain('Fix all');
    await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card .all')!.click());
    await expect.poll(modelText, { timeout: 10000 }).toBe("I don't know.\nSecond line is fine.\nThis is the end.");
  });
}

test('page scroll carries underlines along with the text, before any redraw', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(SENTENCE);
  const [before] = await waitForMarks(page, 2);
  // Read in the same task as the scroll: our scroll handler hasn't run yet.
  const after = await page.evaluate(() => {
    window.scrollBy(0, 40);
    const mark = document.querySelector('rewordly-live')!.shadowRoot!.querySelector('.mark.on')!;
    return mark.getBoundingClientRect().top;
  });
  expect(Math.abs(after - (before!.top - 40))).toBeLessThan(1);
});

function badgeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    return roots.map((r) => r?.querySelector('.badge.on')?.textContent).find((t) => t) ?? '';
  });
}

async function clickBadge(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.badge.on')!.click());
}

test('badge scrolls to an issue above the window and opens its card', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(SENTENCE);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('The end is here.');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(200);
  // Both issues are found but scrolled out of sight, so nothing is drawn.
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('2');
  expect(await marks(page)).toHaveLength(0);

  // Smooth: the page passes through in-between positions instead of jumping.
  const positions = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const started = performance.now();
        const tick = () => {
          seen.push(Math.round(scrollY));
          if (performance.now() - started < 1500) requestAnimationFrame(tick);
          else resolve(seen);
        };
        tick();
      })
  );
  await clickBadge(page);
  expect(new Set(await positions).size).toBeGreaterThan(3);
  await expect.poll(() => cardText(page)).toContain('dont→');
  const visible = (await marks(page)).filter((m) => m.top >= 0 && m.top < 720);
  expect(visible.length).toBeGreaterThan(0);

  // Again: steps to the next issue.
  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('teh→');
});

test('badge scrolls a textarea to an issue hidden in its own scroll area', async ({ page }) => {
  await page.click('#ta-scroll');
  await page.keyboard.type(`${SENTENCE}${'\n'.repeat(8)}The end is here.`);
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('2');
  expect(await page.$eval('#ta-scroll', (el) => el.scrollTop)).toBeGreaterThan(40);

  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('dont→');
  expect(await page.$eval('#ta-scroll', (el) => el.scrollTop)).toBeLessThan(20);
});

test("a suggestion that would undo an applied fix is dropped (no fix loops)", async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('Ich glaube dass, es geht.');
  const [mark] = await waitForMarks(page, 1);
  await applyFirstSuggestion(page, mark!, 'dass,');
  await expect(page.locator('#ta')).toHaveValue('Ich glaube dass es geht.');
  // The fixed sentence counts as checked; if it were sent again the mock would want the comma back.
  // Past the caret grace period (the caret sits right after the fixed word).
  await new Promise((r) => setTimeout(r, 2000));
  expect(await marks(page)).toHaveLength(0);
});

test('an open card stays while the pointer crosses the next line on the way to it', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('I dont know it.\nteh end is near.');
  const [dont, teh] = await waitForMarks(page, 2);
  await page.mouse.move(dont!.left + dont!.width / 2, dont!.top + dont!.height / 2);
  await expect.poll(() => cardText(page)).toContain('dont→');

  // The next line's word sits right under the card: the card must not switch or close.
  await page.mouse.move(teh!.left + teh!.width / 2, teh!.top + teh!.height / 2, { steps: 4 });
  await new Promise((r) => setTimeout(r, 800));
  expect(await cardText(page)).toContain('dont→');
});

test('with a card open, another word takes over only once the pointer rests on it', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('I dont know the way to the station, it is far, teh end.');
  const [dont, teh] = await waitForMarks(page, 2);
  await page.mouse.move(dont!.left + dont!.width / 2, dont!.top + dont!.height / 2);
  await expect.poll(() => cardText(page)).toContain('dont→');

  await page.mouse.move(teh!.left + teh!.width / 2, teh!.top + teh!.height / 2, { steps: 4 });
  await new Promise((r) => setTimeout(r, 150));
  expect(await cardText(page)).toContain('dont→');
  await expect.poll(() => cardText(page)).toContain('teh→');
});

test("the browser's own spellcheck is off while we check a field, and comes back after", async ({ page, context }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  await expect(page.locator('#ta')).toHaveAttribute('spellcheck', 'false');
  await expect(page.locator('#ce')).not.toHaveAttribute('spellcheck', 'false');

  // Turning live checking off restores the field as it was.
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.sync.set({ rewordlyProactiveEnabled: false }));
  await expect(page.locator('#ta')).not.toHaveAttribute('spellcheck', 'false');
});

test('badge navigation highlights the issue at once', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  const active = () =>
    page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelectorAll('.mark.active').length);
  await clickBadge(page);
  await expect.poll(active, { timeout: 150, intervals: [16] }).toBe(1);
});

test('a card opened from the badge stays while the pointer travels, a click elsewhere closes it', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('dont→');

  // Wander over empty page space (no word, not the card) for longer than the hover-close delay.
  await page.mouse.move(700, 600, { steps: 5 });
  await page.mouse.move(650, 650, { steps: 5 });
  await new Promise((r) => setTimeout(r, 800));
  expect(await cardText(page)).toContain('dont→');

  await page.mouse.click(700, 650);
  await expect.poll(() => cardText(page)).toBe('');
});

test('a card opened by hovering closes once the pointer leaves', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await page.mouse.move(dont!.left + dont!.width / 2, dont!.top + dont!.height / 2);
  await expect.poll(() => cardText(page)).toContain('dont→');
  await page.mouse.move(700, 650, { steps: 5 });
  await expect.poll(() => cardText(page)).toBe('');
});

test("a scroll area's own scroll carries underlines and the badge along, before any redraw", async ({ page }) => {
  await page.click('#panel-ce');
  await page.keyboard.type(SENTENCE);
  const [before] = await waitForMarks(page, 2);
  await expect.poll(() => badgeText(page)).toBe('2');
  // Drawn inside the scroll area (next to the editor), not in the page-level overlay.
  const marksIn = () =>
    page.evaluate(() => {
      const root = document.querySelector('#panel rewordly-anchor')?.shadowRoot;
      const mark = root?.querySelector('.mark.on')?.getBoundingClientRect();
      const badge = root?.querySelector('.badge.on')?.getBoundingClientRect();
      return { mark: mark?.top ?? null, badge: badge?.top ?? null };
    });
  const start = await marksIn();
  expect(start.mark).toBeCloseTo(before!.top, 0);
  expect(start.badge).not.toBeNull();

  const after = await page.evaluate(() => {
    document.getElementById('panel')!.scrollTop = 30;
    const root = document.querySelector('#panel rewordly-anchor')!.shadowRoot!;
    return {
      mark: root.querySelector('.mark.on')!.getBoundingClientRect().top,
      badge: root.querySelector('.badge.on')!.getBoundingClientRect().top,
    };
  });
  expect(after.mark).toBeCloseTo(start.mark! - 30, 0);
  expect(after.badge).toBeCloseTo(start.badge! - 30, 0);
  // Carried by the scroll area itself, so nothing needs to step aside.
  expect(await scrollingClips(page)).toBe(0);
  // Nothing of ours is left in the panel once the field is gone.
  await page.evaluate(() => document.getElementById('panel-ce')!.remove());
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#panel rewordly-anchor').length)).toBe(0);
});

test('fixed sentences are not sent again, so "Fix all" stays done', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(`${SENTENCE} We recieve teh mail.`);
  await waitForMarks(page, 4);
  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('Fix all (4)');
  const checks = stats.checks;
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card .all')!.click());
  await expect(page.locator('#ce')).toHaveText("I don't know the answer. We receive the mail.");
  await expect.poll(() => badgeText(page)).toBe('✓');
  await new Promise((r) => setTimeout(r, 2500));
  expect(stats.checks).toBe(checks);
  // Done: no count and no spinner (the ✓ itself may have faded by now).
  expect(await badgeText(page)).not.toMatch(/^\d/);
});

test('fixing one issue keeps the sentence’s other issues without a new check', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  const checks = stats.checks;
  await applyFirstSuggestion(page, dont!);
  await expect(page.locator('#ta')).toHaveValue("I don't know teh answer.");
  await waitForMarks(page, 1);
  await new Promise((r) => setTimeout(r, 2000));
  expect(stats.checks).toBe(checks);
  expect(await marks(page)).toHaveLength(1);
});

test('after a fix from the badge, the next issue opens by itself (scrolling to it)', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(SENTENCE);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('We recieve mail.');
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('3');
  await page.evaluate(() => scrollTo(0, 0));

  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('dont→');
  const clickSuggestion = () =>
    page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card .to')!.click());
  await clickSuggestion();
  await expect.poll(() => cardText(page)).toContain('teh→');
  await clickSuggestion();
  // The last one is far below: scrolled to, then opened.
  await expect.poll(() => cardText(page), { timeout: 5000 }).toContain('recieve→');
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(200);
  await clickSuggestion();
  await expect.poll(() => badgeText(page)).toBe('✓');
  expect(await cardText(page)).toBe('');
});

test('usage counters reach the API per site, without any text', async ({ page }) => {
  stats.events = [];
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [dont] = await waitForMarks(page, 2);
  await applyFirstSuggestion(page, dont!);
  await clickBadge(page);

  const total = (event: string) => stats.events.filter((e) => e.event === event).reduce((n, e) => n + e.count, 0);
  await expect.poll(() => total('live_fix'), { timeout: 10000 }).toBe(1);
  await expect.poll(() => total('live_badge')).toBeGreaterThanOrEqual(1);
  expect(total('live_check')).toBeGreaterThanOrEqual(1);
  // localhost is never recorded by name.
  expect(new Set(stats.events.map((e) => e.host))).toEqual(new Set(['private']));
  expect(JSON.stringify(stats.events)).not.toContain('know');
});

test('links, mentions and hashtags are never underlined, even when the model flags them', async ({ page }) => {
  await page.click('#ta');
  // The mock flags "statusss" wherever it appears, like the model sometimes does inside a link.
  await page.keyboard.type('I dont see https://x.com/eliftabiki1/statusss/2115 or #statusss here.');
  const found = await waitForMarks(page, 1);
  await new Promise((r) => setTimeout(r, 500));
  expect(await marks(page)).toHaveLength(1);
  await applyFirstSuggestion(page, found[0]!);
  await expect(page.locator('#ta')).toHaveValue("I don't see https://x.com/eliftabiki1/statusss/2115 or #statusss here.");
});

test('editor slotted into a web component inside a scroll area: underlines and badge are visible', async ({ page }) => {
  await page.click('#slotted-ce');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  // Drawn (non-zero boxes), not just created somewhere that never renders.
  const drawn = () =>
    page.evaluate(() => {
      const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
      const boxes = (selector: string) =>
        roots.flatMap((r) => Array.from(r?.querySelectorAll(selector) ?? [])).filter((m) => m.getBoundingClientRect().width > 0).length;
      return { marks: boxes('.mark.on'), badge: boxes('.badge.on') };
    });
  await expect.poll(drawn).toEqual({ marks: 2, badge: 1 });
});

test("page rules that hide undefined custom elements don't hide ours", async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  await expect.poll(() => badgeText(page)).toBe('2');
  // The badge is what you see (and can click) at its own spot.
  const onTop = await page.evaluate(() => {
    const badge = document.querySelector('rewordly-live')!.shadowRoot!.querySelector('.badge.on')!.getBoundingClientRect();
    return document.elementFromPoint(badge.left + badge.width / 2, badge.top + badge.height / 2)?.tagName;
  });
  expect(onTop).toBe('REWORDLY-LIVE');
});

test('a suggestion that only repeats the next word is not shown, and an applied one is gone for good', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('Bence yanlışın var kanka.');
  await expect.poll(() => stats.texts.includes('Bence yanlışın var kanka.'), { timeout: 10000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 800));
  expect(await marks(page)).toHaveLength(0);
  expect(await badgeText(page)).toBe('');

  // A real missing word: applied once, then no underline and no second "var".
  await page.$eval('#ta', (el) => ((el as HTMLTextAreaElement).value = ''));
  await page.keyboard.type('Bence yanlışın kanka.');
  const [mark] = await waitForMarks(page, 1);
  await applyFirstSuggestion(page, mark!, 'yanlışın');
  await expect(page.locator('#ta')).toHaveValue('Bence yanlışın var kanka.');
  await new Promise((r) => setTimeout(r, 2000));
  expect(await marks(page)).toHaveLength(0);
  expect(await badgeText(page)).not.toMatch(/^\d/);
});

test("an editor turning the browser's spellcheck back on is answered after a short pause", async ({ page }) => {
  await page.click('#notion-ce');
  await page.keyboard.type('Testiing');
  await expect(page.locator('#notion-ce')).toHaveAttribute('spellcheck', 'false');
  // The editor sets it back on with the next keystroke; it is switched off again shortly after, not instantly:
  // answering at once is how a tab ends up in a loop with a page that undoes the change.
  await page.keyboard.type('x');
  await expect(page.locator('#notion-ce')).toHaveAttribute('spellcheck', 'false', { timeout: 1000 });
});

test('spellcheck switched on by an element inside the field is switched off too, and restored after', async ({ page, context }) => {
  await page.$eval('#ce', (el) => (el.innerHTML = '<p spellcheck="true">Inner block</p>'));
  await page.click('#ce');
  await page.keyboard.type(' text');
  await expect(page.locator('#ce p')).toHaveAttribute('spellcheck', 'false');
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.sync.set({ rewordlyProactiveEnabled: false }));
  await expect(page.locator('#ce p')).toHaveAttribute('spellcheck', 'true');
});

async function badgeBox(page: Page): Promise<{ left: number; right: number; top: number; bottom: number } | null> {
  return page.evaluate(() => {
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    const badge = roots.map((r) => r?.querySelector('.badge.on')).find(Boolean);
    if (!badge) return null;
    const r = badge.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

/** What the badge shows now: its text, "spinner", "!" for an error, "" when hidden. */
function badgeState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    const badge = roots.map((r) => r?.querySelector('.badge.on')).find(Boolean);
    return !badge ? '' : badge.classList.contains('checking') ? 'spinner' : badge.classList.contains('error') ? '!' : badge.textContent ?? '';
  });
}

/**
 * Starts recording what the badge shows: its text, "spinner" for the old checking state, "!" for
 * an error, "" when hidden. Returns a function that stops and gives the distinct states in order.
 */
async function recordBadge(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __badge: string[]; __badgeTimer: number };
    w.__badge = [];
    let last: string | null = null;
    w.__badgeTimer = window.setInterval(() => {
      const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
      const badge = roots.map((r) => r?.querySelector('.badge.on')).find(Boolean);
      const state = !badge ? '' : badge.classList.contains('checking') ? 'spinner' : badge.classList.contains('error') ? '!' : badge.textContent ?? '';
      if (state !== last) w.__badge.push(state);
      last = state;
    }, 25);
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __badge: string[]; __badgeTimer: number };
      clearInterval(w.__badgeTimer);
      return w.__badge;
    });
}

test('a clean field shows no badge: not after its check, not on refocus, not while the page scrolls', async ({ page }) => {
  await page.click('#ta');
  await new Promise((r) => setTimeout(r, 1500));
  expect(await badgeText(page)).toBe('');

  const stop = await recordBadge(page);
  await page.keyboard.type('Nothing wrong here.');
  await expect.poll(() => stats.texts.includes('Nothing wrong here.'), { timeout: 10000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 800));
  await page.click('#inp');
  await page.click('#ta');
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 250);
    await new Promise((r) => setTimeout(r, 300));
    await page.mouse.wheel(0, -250);
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(await stop()).toEqual(['']);

  // Issues do show, and stay.
  await page.keyboard.type(' I dont know.');
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('1');
  await new Promise((r) => setTimeout(r, 3500));
  expect(await badgeText(page)).toBe('1');
});

test('pasting text shows no ✓ and no spinner, only the count once issues arrive', async ({ page }) => {
  stats.latencyMs = 1500;
  // Checked once already (cached), like text copied from an earlier draft.
  await page.click('#ta');
  await page.keyboard.type('Thanks for the update. I will check it tomorrow.');
  await expect.poll(() => stats.texts.includes('I will check it tomorrow.'), { timeout: 10000 }).toBe(true);

  // Pasted into another field with an unfinished last line under the caret, which waits for a pause.
  await page.click('#ce');
  const stop = await recordBadge(page);
  await page.keyboard.insertText('Thanks for the update. I will check it tomorrow.\nBest regards');
  await expect.poll(() => stats.texts.includes('Best regards'), { timeout: 10000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 2500));
  await page.keyboard.insertText('\nI dont know.');
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('1');
  expect(await stop()).toEqual(['', '1']);
});

test('fixing the last issue shows ✓ for a moment, and scrolling or refocusing does not bring it back', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('2');
  const stop = await recordBadge(page);
  await clickBadge(page);
  await expect.poll(() => cardText(page)).toContain('Fix all (2)');
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card .all')!.click());
  await expect(page.locator('#ta')).toHaveValue("I don't know the answer.");
  await expect.poll(() => badgeText(page)).toBe('✓');
  await expect.poll(() => badgeText(page), { timeout: 3000 }).toBe('');

  await page.click('#inp');
  await page.click('#ta');
  await page.mouse.wheel(0, 250);
  await new Promise((r) => setTimeout(r, 300));
  await page.mouse.wheel(0, -250);
  await new Promise((r) => setTimeout(r, 1000));
  const states = await stop();
  expect(states.filter((x) => x === '✓')).toHaveLength(1);
  expect(states.at(-1)).toBe('');
});

test('the badge stays in its corner when text runs under it: small, and out of the way while typing', async ({ page }) => {
  await page.click('#inp');
  await page.keyboard.type('I dont know.');
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('1');
  const fieldRight = await page.$eval('#inp', (el) => el.getBoundingClientRect().right);
  const roomy = (await badgeBox(page))!;
  expect(roomy.right).toBeLessThanOrEqual(fieldRight);
  const compact = () => page.evaluate(() => !!document.querySelector('rewordly-live')?.shadowRoot?.querySelector('.badge.on.compact'));
  expect(await compact()).toBe(false);

  // A line that runs to the right edge puts text under the corner: the badge does not go anywhere else.
  await page.keyboard.type(` ${'and so on '.repeat(40)}`);
  // Not while typing: it steps aside for a moment...
  expect(await badgeBox(page)).toBeNull();
  // ...and comes back, in the same corner, smaller.
  await expect.poll(compact, { timeout: 4000 }).toBe(true);
  const back = (await badgeBox(page))!;
  expect(back.right).toBeLessThanOrEqual(fieldRight);
  expect(Math.abs(back.right - roomy.right)).toBeLessThan(12);
});

test('a check in flight shows nothing: the last count stays, a slow first check stays quiet', async ({ page }) => {
  stats.latencyMs = 2500;
  await page.click('#ta');
  const first = await recordBadge(page);
  await page.keyboard.type(SENTENCE);
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('2');
  expect(await first()).toEqual(['', '2']);

  const later = await recordBadge(page);
  await page.keyboard.type(' More words here, that need a check teh.', { delay: 30 });
  await expect.poll(() => badgeText(page), { timeout: 10000 }).toBe('3');
  expect(await later()).toEqual(['2', '3']);
});

test('one failed check stays quiet; a check that keeps failing shows "!", and it goes once checks work again', async ({ page }) => {
  await page.click('#ta');
  stats.failAll = true;
  const stop = await recordBadge(page);
  await page.keyboard.type('Nothing wrong here.');
  await expect.poll(() => stats.failures, { timeout: 10000 }).toBe(1);
  await new Promise((r) => setTimeout(r, 500));
  expect(await badgeState(page)).toBe('');
  await expect.poll(() => badgeState(page), { timeout: 10000 }).toBe('!');
  stats.failAll = false;
  await expect.poll(() => badgeState(page), { timeout: 15000 }).toBe('');
  expect(await stop()).toEqual(['', '!', '']);
});

test('"Always ignore" silences a suggestion for good, also after a reload', async ({ page }) => {
  const text = 'Ich glaube dass, es geht.';
  await page.click('#ta');
  await page.keyboard.type(text);
  const [mark] = await waitForMarks(page, 1);
  await page.mouse.move(mark!.left + mark!.width / 2, mark!.top + mark!.height / 2);
  await expect.poll(() => cardText(page)).toContain('dass');
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card [data-act="always"]')!.click());
  await expect.poll(async () => (await marks(page)).length).toBe(0);

  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30000 });
  await page.click('#ta');
  await page.keyboard.type(text);
  await new Promise((r) => setTimeout(r, 2500));
  expect(await marks(page)).toHaveLength(0);
});

test('ignoring a suggestion reports its fingerprint, and only that', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('Ich glaube dass, es geht und teh.');
  const found = await waitForMarks(page, 2);
  const mark = found[0]!;
  await page.mouse.move(mark.left + mark.width / 2, mark.top + mark.height / 2);
  await expect.poll(() => cardText(page)).toContain('dass');
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card [data-act="ignore"]')!.click());
  await expect.poll(() => stats.feedback.length).toBe(1);
  expect(stats.feedback[0]).toMatch(/^[0-9a-f]{40}$/);
  // Applying the other suggestion is not an ignore.
  await new Promise((r) => setTimeout(r, 500));
  expect(stats.feedback).toHaveLength(1);
});

const sw = (context: BrowserContext) => context.serviceWorkers()[0]!;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('"Disable Rewordly on this page" takes effect at once, and enabling brings it back', async ({ page, context }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);

  await sw(context).evaluate((origin) => chrome.storage.sync.set({ rewordlyDisabledPages: [origin] }), ORIGIN);
  await expect.poll(async () => (await marks(page)).length).toBe(0);
  const sent = stats.paragraphs;
  await page.keyboard.type(' And teh next one dont work.');
  await settle(2500);
  expect(stats.paragraphs).toBe(sent);
  expect(await marks(page)).toHaveLength(0);
  expect(await badgeText(page)).toBe('');

  await sw(context).evaluate(() => chrome.storage.sync.set({ rewordlyDisabledPages: [] }));
  await page.keyboard.type(' Teh end.');
  await expect.poll(async () => (await marks(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
});

test('an editor in a frame from another origin follows the page that frames it', async ({ page, context }) => {
  // The page itself is on localhost; the frame is the same server reached by another hostname, so another origin.
  await page.evaluate((port) => {
    const f = document.createElement('iframe');
    f.id = 'cross';
    f.src = `http://127.0.0.1:${port}/frame.html`;
    f.style.cssText = 'width:400px;height:200px';
    document.body.append(f);
  }, PORT);
  const frame = (await (await page.waitForSelector('#cross')).contentFrame())!;
  await frame.waitForSelector('#inner');
  // Control: the framed editor is checked while the page is enabled.
  await frame.click('#inner');
  await page.keyboard.type(SENTENCE);
  await expect.poll(async () => (await marks(frame)).length, { timeout: 10000 }).toBe(2);

  await sw(context).evaluate((origin) => chrome.storage.sync.set({ rewordlyDisabledPages: [origin] }), ORIGIN);
  await expect.poll(async () => (await marks(frame)).length).toBe(0);
  const before = stats.paragraphs;
  await page.keyboard.type(' And teh next one dont work.');
  await settle(2500);
  expect(stats.paragraphs).toBe(before);
  expect(await marks(frame)).toHaveLength(0);
});

test('while an IME is composing nothing is sent; the finished text is checked afterwards', async ({ page }) => {
  await page.click('#ta');
  const before = stats.paragraphs;
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('#ta')!;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }));
    ta.value = 'I dont know teh';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertCompositionText', isComposing: true }));
  });
  await settle(3500);
  expect(stats.paragraphs).toBe(before);
  expect(await marks(page)).toHaveLength(0);

  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('#ta')!;
    ta.value = 'I dont know teh answer.';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertCompositionText', isComposing: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }));
  });
  await waitForMarks(page, 2);
  expect(stats.texts.every((t) => t === 'I dont know teh answer.')).toBe(true);
});

test('a suggestion cannot be applied in the middle of a composition', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type(SENTENCE);
  const [mark] = await waitForMarks(page, 2);
  await page.evaluate(() => document.querySelector('#ta')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true })));
  await page.mouse.move(mark!.left + mark!.width / 2, mark!.top + mark!.height / 2);
  await expect.poll(() => cardText(page)).toContain('dont');
  await page.evaluate(() => document.querySelector('rewordly-live')!.shadowRoot!.querySelector<HTMLButtonElement>('.card .to')!.click());
  await settle(500);
  expect(await page.inputValue('#ta')).toBe(SENTENCE);
});

test('secrets are never sent: not from a password field shown as text, not from a sentence that contains a key or a card', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('My key is sk-proj-AbCdEf1234567890AbCdEf1234567890 so teh login works. ');
  await page.keyboard.type('Pay with 4242 4242 4242 4242 please. ');
  await page.keyboard.type('Sifre: kedi1234 oldu. ');
  await page.keyboard.type('And I dont know teh answer.');
  await expect.poll(async () => (await marks(page)).length, { timeout: 10000 }).toBe(2);
  await settle(1500);
  expect(stats.texts.length).toBeGreaterThan(0);
  for (const text of stats.texts) {
    expect(text).not.toMatch(/sk-proj|4242|kedi1234/);
  }
  expect(stats.texts.some((t) => t.includes('I dont know teh answer'))).toBe(true);
});

test('a reply full of impossible ranges, missing fields and markup is survived: only the valid issues show, nothing is injected', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.click('#ta');
  await page.keyboard.type('MALICIOUS input with teh typo.');
  await expect.poll(async () => (await marks(page)).length, { timeout: 10000 }).toBe(2);
  await settle(500);

  const [first] = await waitForMarks(page, 2);
  await page.mouse.move(first!.left + first!.width / 2, first!.top + first!.height / 2);
  await expect.poll(() => cardText(page)).toContain('onerror');
  const injected = await page.evaluate(() => ({
    pwned: (window as unknown as { __pwned?: number }).__pwned,
    images: document.querySelectorAll('img').length + (document.querySelector('rewordly-live')?.shadowRoot?.querySelectorAll('img').length ?? 0),
  }));
  expect(injected).toEqual({ pwned: undefined, images: 0 });
  expect(errors).toEqual([]);
  // Still responsive: typing on works.
  await page.keyboard.type(' More text.');
  expect(await page.inputValue('#ta')).toContain('More text.');
});

test('one sentence the server chokes on does not hold back the others, and is not retried for ever', async ({ page }) => {
  await page.click('#ta');
  await page.keyboard.type('I dont know. ');
  await waitForMarks(page, 1);
  stats.failures = 0;

  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('#ta')!;
    ta.value = 'I dont know. This POISON line breaks it. And teh other one. Also wierd stuff.';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  });
  // The healthy sentences get their underlines even though one sentence in the same text always fails.
  await expect.poll(async () => (await marks(page)).length, { timeout: 40000 }).toBe(3);
  // The failing sentence gets a few tries on its own, then it is set aside: the number of failures stops growing.
  await settle(14000);
  const failedByNow = stats.failures;
  await settle(8000);
  expect(stats.failures).toBe(failedByNow);
  expect(failedByNow).toBeLessThanOrEqual(8);
});

test('a server that is down is not hammered: a few retries, then a pause, however much is typed', async ({ page }) => {
  await page.click('#ta');
  stats.failAll = true;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.type(`Sentence number ${i} with teh typo. `);
    await settle(900);
  }
  await settle(1500);
  expect(stats.failures).toBeGreaterThan(1);
  expect(stats.failures).toBeLessThanOrEqual(7);
});

test('pasting a huge text sends only the part around the caret, and the page stays responsive', async ({ page }) => {
  // Different sentences (identical ones would be a single unit).
  const huge = Array.from({ length: 5000 }, (_, i) => `Sentence number ${i} is a perfectly normal line about nothing.`).join(' ');
  expect(huge.length).toBeGreaterThan(250_000);
  await page.click('#ta');
  const checksBefore = stats.checks;
  const started = Date.now();
  await page.fill('#ta', huge);
  await settle(5000);
  // About 2000 characters before the caret and a sentence or two around it: nowhere near the 300 000 pasted.
  expect(stats.chars).toBeGreaterThan(0);
  expect(stats.chars).toBeLessThanOrEqual(4500);
  expect(stats.checks - checksBefore).toBeLessThanOrEqual(6);
  // The main thread is free: a frame comes back quickly and typing still works.
  const frameMs = await page.evaluate(() => new Promise<number>((r) => { const t = performance.now(); requestAnimationFrame(() => r(performance.now() - t)); }));
  expect(frameMs).toBeLessThan(1000);
  const typedAt = Date.now();
  await page.keyboard.type('x');
  expect(Date.now() - typedAt).toBeLessThan(2000);
  expect(Date.now() - started).toBeLessThan(25000);
});

/** Opacity of the first visible underline in any of our roots (0 while it is stepping aside). */
const markOpacity = (page: Page) =>
  page.evaluate(() => {
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    const mark = roots.map((r) => r?.querySelector('.mark.on')).find(Boolean);
    return mark ? getComputedStyle(mark).opacity : null;
  });

const scrollingClips = (page: Page) =>
  page.evaluate(() => {
    const roots = [document.querySelector('rewordly-live'), ...document.querySelectorAll('rewordly-anchor')].map((h) => h?.shadowRoot);
    return roots.reduce((n, r) => n + (r?.querySelectorAll('.clip.scrolling').length ?? 0), 0);
  });

test('a field that scrolls itself: underlines step aside while it scrolls and come back after', async ({ page }) => {
  await page.click('#ta-scroll');
  await page.keyboard.insertText(`${SENTENCE}\n${'Fine line.\n'.repeat(12)}`);
  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 0));
  await waitForMarks(page, 2);
  expect(await markOpacity(page)).toBe('1');

  await page.$eval('#ta-scroll', (el) => (el.scrollTop = 4));
  await expect.poll(() => scrollingClips(page), { timeout: 500, intervals: [16] }).toBe(1);
  expect(await markOpacity(page)).toBe('0');
  await expect.poll(() => scrollingClips(page), { timeout: 2000 }).toBe(0);
  await expect.poll(() => markOpacity(page), { timeout: 2000 }).toBe('1');
});

test("a scroll area we couldn't anchor in: underlines step aside while it scrolls and come back after", async ({ page }) => {
  await page.click('#plain-ce');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  await page.$eval('#plain-panel', (el) => (el.scrollTop = 20));
  await expect.poll(() => scrollingClips(page), { timeout: 500, intervals: [16] }).toBe(1);
  await expect.poll(() => scrollingClips(page), { timeout: 2000 }).toBe(0);
  await expect.poll(() => markOpacity(page), { timeout: 2000 }).toBe('1');
});

test('a scroller that has nothing to do with the field leaves the underlines alone', async ({ page }) => {
  await page.click('#ce');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  await page.$eval('#plain-panel', (el) => (el.scrollTop = 20));
  await page.$eval('#panel', (el) => (el.scrollTop = 20));
  await new Promise((r) => setTimeout(r, 100));
  expect(await scrollingClips(page)).toBe(0);
  expect(await markOpacity(page)).toBe('1');
});

test('a page that keeps undoing our spellcheck change: we give up quickly instead of fighting forever', async ({ page }) => {
  await page.click('#fight-ce');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  const writes = () => page.evaluate(() => (window as unknown as { __fightWrites: number }).__fightWrites);
  await new Promise((r) => setTimeout(r, 1500));
  const settled = await writes();
  await new Promise((r) => setTimeout(r, 2500));
  // A handful of rounds at most, and then nothing more (a real fight goes on for ever).
  expect(settled).toBeLessThan(30);
  expect(await writes()).toBe(settled);
  // The checker itself keeps working there.
  expect(await marks(page)).toHaveLength(2);
});

test('a code block inside a rich editor is not checked, the text around it is', async ({ page }) => {
  await page.click('#ce-code p');
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(' I dont see teh error.');
  // Only the typed sentence: the code block repeats both typos and must not be underlined or sent.
  const found = await waitForMarks(page, 2);
  await new Promise((r) => setTimeout(r, 1200));
  expect(await marks(page)).toHaveLength(2);
  const codeTop = await page.$eval('#ce-code .ql-code-block', (el) => el.getBoundingClientRect().top);
  expect(found.every((m) => m.top < codeTop)).toBe(true);
});

test('a page that keeps removing our anchor: we stop putting it back, and the underlines still work', async ({ page }) => {
  await page.click('#hostile-ce');
  await page.keyboard.type(SENTENCE);
  await waitForMarks(page, 2);
  const removals = () => page.evaluate(() => (window as unknown as { __anchorRemovals: number }).__anchorRemovals);
  await new Promise((r) => setTimeout(r, 1500));
  const settled = await removals();
  await new Promise((r) => setTimeout(r, 2500));
  expect(settled).toBeLessThan(15);
  expect(await removals()).toBe(settled);
  expect(await marks(page)).toHaveLength(2);
});
