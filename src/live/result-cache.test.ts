import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const issue = { offset: 0, length: 3, original: 'teh', replacements: ['the'], message: '', type: 'spelling' as const };

let store: Record<string, unknown>;

async function freshCache() {
  vi.resetModules();
  return import('./result-cache');
}

describe('result cache lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (items: Record<string, unknown>) => void Object.assign(store, items),
        },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('serves a stored result until it is a week old, however often it is used', async () => {
    const { storeResults, lookupResults } = await freshCache();
    await storeResults([{ id: 'a', issues: [issue] }]);
    vi.setSystemTime(Date.now() + 6 * DAY);
    expect((await lookupResults(['a'])).get('a')).toEqual([issue]);
    // Use refreshed "last used", but the age is counted from when it was received.
    vi.setSystemTime(Date.now() + 2 * DAY);
    expect((await lookupResults(['a'])).has('a')).toBe(false);
  });

  it('drops expired entries when loading from storage, and keeps fresh ones', async () => {
    const first = await freshCache();
    await first.storeResults([{ id: 'old', issues: [issue] }]);
    vi.setSystemTime(Date.now() + 5 * DAY);
    await first.storeResults([{ id: 'new', issues: [issue] }]);
    await vi.advanceTimersByTimeAsync(3000); // debounce → saved
    vi.setSystemTime(Date.now() + 3 * DAY); // old: 8 days, new: 3 days

    const second = await freshCache();
    const hits = await second.lookupResults(['old', 'new']);
    expect([...hits.keys()]).toEqual(['new']);
  });

  it('treats entries saved before the age limit existed as expired', async () => {
    store['rewordlyLiveCache'] = { v: 4, e: { legacy: [[issue], Date.now()] } };
    const { lookupResults } = await freshCache();
    expect((await lookupResults(['legacy'])).size).toBe(0);
  });
});
