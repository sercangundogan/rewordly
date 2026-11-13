// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldAdapter } from './adapters';
import type { SessionHost } from './session';

const { requestCheck } = vi.hoisted(() => ({ requestCheck: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), requestCheck }));

type Sent = string[];
const ok = (paragraphs: Array<{ id: string }>) => ({ kind: 'ok' as const, quota: null, results: new Map(paragraphs.map((p) => [p.id, []])) });
const failed = { kind: 'error' as const };

function setup() {
  const field = { text: '' };
  const adapter = {
    el: document.createElement('textarea'),
    readText: () => field.text,
    rectsFor: () => [],
    textRects: () => [],
    caret: () => field.text.length,
    reveal: async () => undefined,
    replace: async () => true,
    dispose: () => undefined,
  } as unknown as FieldAdapter;
  const state = { composing: false };
  const host: SessionHost = {
    changed: () => undefined,
    isPaused: () => false,
    reportLimit: () => undefined,
    reportQuota: () => undefined,
    isIgnored: () => false,
    isComposing: () => state.composing,
  };
  return { field, adapter, host, state };
}

async function session() {
  vi.resetModules();
  const { FieldSession } = await import('./session');
  const env = setup();
  return { ...env, session: new FieldSession(env.adapter, env.host) };
}

/** Types a sentence, the way a user does, and lets time pass. */
async function type(s: Awaited<ReturnType<typeof session>>, text: string, wait = 1000) {
  s.field.text += text;
  s.session.sync(true);
  await vi.advanceTimersByTimeAsync(wait);
}

const allSent = (): Sent => requestCheck.mock.calls.flatMap(([paragraphs]) => (paragraphs as Array<{ text: string }>).map((p) => p.text));

beforeEach(() => {
  vi.useFakeTimers();
  requestCheck.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('a server that keeps failing', () => {
  it('is retried a few times and then left alone for a while, however much is typed', async () => {
    requestCheck.mockResolvedValue(failed);
    const s = await session();
    for (let i = 0; i < 120; i++) await type(s, `Typing sentence number ${i} here. `);
    // 120 seconds of typing: 6 failed requests, then a pause (not one request per keystroke pause).
    expect(requestCheck.mock.calls.length).toBeLessThanOrEqual(6);
    expect(requestCheck.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.session.status).toBe('error');
  });

  it('tries again once the pause is over, and recovers when the server does', async () => {
    requestCheck.mockResolvedValue(failed);
    const s = await session();
    for (let i = 0; i < 60; i++) await type(s, `Sentence ${i} is typed here. `);
    const during = requestCheck.mock.calls.length;
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(requestCheck.mock.calls.length).toBeGreaterThan(during);
    expect(s.session.status).not.toBe('error');
    expect(s.session.hasResult).toBe(true);
  });

  it('is not mistaken for one bad sentence: a lone sentence is never marked checked while nothing has worked yet', async () => {
    requestCheck.mockResolvedValue(failed);
    const s = await session();
    await type(s, 'Only one sentence here. ', 60_000);
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    // After the outage the sentence is still checked (not skipped for good).
    expect(requestCheck.mock.calls[requestCheck.mock.calls.length - 1]![0]).toEqual([expect.objectContaining({ text: 'Only one sentence here.' })]);
    expect(s.session.status).toBe('done');
  });
});

describe('one sentence the server cannot handle', () => {
  it('goes alone after a failure, so the others are checked; then it is set aside, and tried again later', async () => {
    requestCheck.mockImplementation(async (p: Array<{ id: string; text: string }>) =>
      p.some((x) => x.text.includes('POISON')) ? failed : ok(p)
    );
    const s = await session();
    await type(s, 'The first one is fine. ', 3000);
    expect(s.session.hasResult).toBe(true);

    // Four sentences arrive at once (a paste): one of them breaks every request it is in.
    await type(s, 'Second is fine. This POISON one breaks it. Third is fine. Fourth is fine. ', 60_000);
    const sent = allSent();
    for (const fine of ['Second is fine.', 'Third is fine.', 'Fourth is fine.']) expect(sent).toContain(fine);
    const poisonTries = sent.filter((t) => t.includes('POISON')).length;
    // A few tries on its own (and with the batch it started in), then no more.
    expect(poisonTries).toBeGreaterThanOrEqual(3);
    expect(poisonTries).toBeLessThanOrEqual(7);
    const before = allSent().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(allSent().length).toBe(before);

    // Set aside for a while, not for good: after a few minutes it is tried again.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    s.session.schedule(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(allSent().length).toBeGreaterThan(before);
  });
});

describe('composition', () => {
  it('nothing is sent while an IME is composing, and the text is checked once it ends', async () => {
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    const s = await session();
    s.state.composing = true;
    await type(s, 'Half typed sentence here. ', 10_000);
    expect(requestCheck).not.toHaveBeenCalled();
    s.state.composing = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(allSent()).toEqual(['Half typed sentence here.']);
  });

  it('a suggestion is not applied in the middle of a composition', async () => {
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    const s = await session();
    s.state.composing = true;
    const replace = vi.spyOn(s.adapter, 'replace');
    const applied = await s.session.apply({ id: 'x', offset: 0, length: 4, original: 'Half', replacements: ['Whole'], message: '', type: 'spelling' }, 'Whole');
    expect(applied).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('sensitive text never leaves the field', () => {
  it('a sentence with a key, a card or a written-out password is not sent; its neighbours are', async () => {
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    const s = await session();
    await type(s, 'My key is sk-proj-AbCdEf1234567890AbCdEf1234567890 ok. Card 4242 4242 4242 4242 here. Şifre: kedi1234 oldu. This one is plain. ', 5000);
    expect(allSent()).toEqual(['This one is plain.']);
  });

  it('the verdict does not depend on how often the field is re-read', async () => {
    requestCheck.mockImplementation(async (p: Array<{ id: string }>) => ok(p));
    const s = await session();
    await type(s, 'Token a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 here. ', 3000);
    for (let i = 0; i < 20; i++) await type(s, 'x', 500);
    expect(allSent().some((t) => t.includes('a1B2c3D4'))).toBe(false);
  });
});

describe('a finished sentence is checked without the full typing pause', () => {
  it('goes out about 150 ms after ". ", and typing on does not push it back', async () => {
    requestCheck.mockImplementation(async (p) => ok(p));
    const s = await session();
    await type(s, 'Thanks for the update. ', 100);
    expect(allSent()).toEqual([]);
    // The next sentence is already being typed.
    await type(s, 'I', 30);
    await type(s, ' will', 60);
    expect(allSent()).toEqual(['Thanks for the update.']);
  });

  it('"?" and "!" need no space after them', async () => {
    requestCheck.mockImplementation(async (p) => ok(p));
    const s = await session();
    await type(s, 'Are you sure?', 200);
    expect(allSent()).toEqual(['Are you sure?']);
  });

  it('a bare period waits 400 ms, so "3.5" typed in one go is never sent as "3."', async () => {
    requestCheck.mockImplementation(async (p) => ok(p));
    const s = await session();
    await type(s, 'It costs 3.', 250);
    expect(allSent()).toEqual([]);
    await type(s, '5 dollars', 500);
    expect(allSent()).toEqual([]);

    const t = await session();
    await type(t, 'It is done.', 450);
    expect(allSent()).toEqual(['It is done.']);
  });

  it('editing inside a finished sentence still waits for the full pause', async () => {
    requestCheck.mockImplementation(async (p) => ok(p));
    const s = await session();
    s.field.text = 'I dont know the answer.';
    (s.adapter as unknown as { caret: () => number }).caret = () => 6;
    s.session.sync(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(allSent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(allSent()).toEqual(['I dont know the answer.']);
  });
});

describe('the underline under the caret hides only while typing in that word', () => {
  const flagged = (p: Array<{ id: string }>) => ({
    kind: 'ok' as const,
    quota: null,
    results: new Map(p.map((x) => [x.id, [{ offset: 2, length: 4, original: 'dont', replacements: ["don't"], message: '', type: 'spelling' as const }]])),
  });

  it('a click into a flagged word right after typing elsewhere keeps its underline', async () => {
    requestCheck.mockImplementation(async (p) => flagged(p));
    const s = await session();
    await type(s, 'I dont know.', 500);
    expect(s.session.visibleIssues().map((i) => i.original)).toEqual(['dont']);
    // The caret is put into "dont" less than 1.5 s after the last keystroke.
    (s.adapter as unknown as { caret: () => number }).caret = () => 4;
    expect(s.session.visibleIssues().map((i) => i.original)).toEqual(['dont']);
  });

  it('typing right at a flagged word still hides it for a moment', async () => {
    requestCheck.mockImplementation(async (p) => flagged(p));
    const s = await session();
    await type(s, 'I dont know.', 2000);
    (s.adapter as unknown as { caret: () => number }).caret = () => 6;
    s.session.sync(true);
    expect(s.session.visibleIssues()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.session.visibleIssues().map((i) => i.original)).toEqual(['dont']);
  });
});
