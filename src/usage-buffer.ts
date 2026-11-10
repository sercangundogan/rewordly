/**
 * Background side of usage counting (see src/usage.ts): counts per site + event, kept in
 * chrome.storage.local so a service worker restart loses nothing, sent about once a minute.
 */

import { getApiHeaders } from './auth';
import { API_BASE } from './config';
import type { UsageEvent } from './usage';

declare const process: { env: Record<string, string | undefined> };

const BUFFER_KEY = 'rewordly_usage_buffer';
const FLUSH_MS = Number(process.env['USAGE_FLUSH_MS']) || 60_000;
/** The API accepts up to 100 rows per batch. */
const MAX_ROWS = 100;

interface Row {
  host: string;
  event: UsageEvent;
  count: number;
  chars: number;
}

interface Pending {
  since: number;
  rows: Record<string, Row>;
}

/** Storage reads and writes run one after another, so concurrent events don't overwrite each other. */
let queue: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch(() => undefined);
}

async function load(): Promise<Pending | null> {
  const stored = await chrome.storage.local.get(BUFFER_KEY);
  return (stored[BUFFER_KEY] as Pending | undefined) ?? null;
}

function merge(pending: Pending, rows: Row[]): void {
  for (const row of rows) {
    const key = `${row.host}\t${row.event}`;
    const existing = pending.rows[key];
    if (existing) {
      existing.count += row.count;
      existing.chars += row.chars;
    } else if (Object.keys(pending.rows).length < MAX_ROWS) {
      pending.rows[key] = { ...row };
    }
  }
}

export function recordUsage(host: string | null, event: UsageEvent, count: number, chars: number): void {
  if (!host || count <= 0) return;
  enqueue(async () => {
    const pending = (await load()) ?? { since: Date.now(), rows: {} };
    merge(pending, [{ host, event, count, chars: Math.max(0, chars) }]);
    await chrome.storage.local.set({ [BUFFER_KEY]: pending });
    schedule(pending.since);
  });
}

/** On worker start: send what an earlier worker collected. */
export function resumeUsageFlush(): void {
  enqueue(async () => {
    const pending = await load();
    if (pending) schedule(pending.since);
  });
}

function schedule(since: number): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    enqueue(flush);
  }, Math.max(0, since + FLUSH_MS - Date.now()));
}

async function flush(): Promise<void> {
  const pending = await load();
  if (!pending) return;
  if (Date.now() - pending.since < FLUSH_MS) return schedule(pending.since);
  await chrome.storage.local.remove(BUFFER_KEY);
  const rows = Object.values(pending.rows);
  try {
    const res = await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers: await getApiHeaders(),
      body: JSON.stringify({ version: chrome.runtime.getManifest().version, events: rows }),
    });
    // Server trouble: keep the counts for the next round. A 4xx would fail again, so drop those.
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (process.env['NODE_ENV'] !== 'production') console.info('[Rewordly usage] sent', rows);
  } catch {
    const current = (await load()) ?? { since: Date.now(), rows: {} };
    merge(current, rows);
    await chrome.storage.local.set({ [BUFFER_KEY]: current });
    schedule(current.since);
  }
}
