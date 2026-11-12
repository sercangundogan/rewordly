/**
 * Persistent live-check results, kept by the background service worker in
 * chrome.storage.local and shared by every tab and frame. A sentence already
 * checked on this device is never sent again, even after a reload.
 */

import type { ParagraphIssue } from './text';

/** Bump together with PROMPT_VERSION in rewordly-web (lib/check/llm.ts) to drop stale results. */
const CACHE_VERSION = 4;
const STORAGE_KEY = 'rewordlyLiveCache';
const MAX_ENTRIES = 3000;
/**
 * How long a result is reused on this device, counted from when it was received (not from last use).
 * Then the sentence is asked again, so a suggestion the server has since dropped or improved
 * does not stay here for ever. Shorter than the server's own cache lifetime.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 2000;

interface Stored {
  v: number;
  /** hash → [issues, last used (ms), received (ms)]; entries without a received time are from before this limit and count as expired. */
  e: Record<string, [ParagraphIssue[], number, number?]>;
}

type Entry = [ParagraphIssue[], number, number?];

const expired = (entry: Entry, now: number): boolean => now - (entry[2] ?? 0) > MAX_AGE_MS;

let entries: Map<string, Entry> | null = null;
let loading: Promise<Map<string, Entry>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Promise<Map<string, Entry>> {
  if (entries) return Promise.resolve(entries);
  loading ??= chrome.storage.local.get(STORAGE_KEY).then((result) => {
    const stored = result[STORAGE_KEY] as Stored | undefined;
    const now = Date.now();
    entries = new Map(stored?.v === CACHE_VERSION ? Object.entries(stored.e).filter(([, entry]) => !expired(entry, now)) : []);
    return entries;
  });
  return loading;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!entries) return;
    // Keep the most recently used entries, minus the ones that outlived their age.
    const now = Date.now();
    const kept = Array.from(entries.entries())
      .filter(([, entry]) => !expired(entry, now))
      .sort((a, b) => b[1][1] - a[1][1])
      .slice(0, MAX_ENTRIES);
    entries = new Map(kept);
    const stored: Stored = { v: CACHE_VERSION, e: Object.fromEntries(kept) };
    void chrome.storage.local.set({ [STORAGE_KEY]: stored });
  }, SAVE_DELAY_MS);
}

/** Cached issues for the given hashes (misses are absent from the map). */
export async function lookupResults(hashes: string[]): Promise<Map<string, ParagraphIssue[]>> {
  const map = await load();
  const now = Date.now();
  const hits = new Map<string, ParagraphIssue[]>();
  let touched = false;
  for (const hash of hashes) {
    const entry = map.get(hash);
    if (entry && expired(entry, now)) {
      map.delete(hash);
      touched = true;
    } else if (entry) {
      hits.set(hash, entry[0]);
      entry[1] = now;
      touched = true;
    }
  }
  if (touched) scheduleSave();
  return hits;
}

export async function storeResults(results: Array<{ id: string; issues: ParagraphIssue[] }>): Promise<void> {
  if (results.length === 0) return;
  const map = await load();
  const now = Date.now();
  for (const r of results) map.set(r.id, [r.issues, now, now]);
  scheduleSave();
}
