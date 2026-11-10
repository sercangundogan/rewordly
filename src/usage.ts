/**
 * Feature usage counters ("which features are used on which sites"), for product decisions.
 * Content scripts report an event; the background worker adds the site's hostname, keeps
 * counts per hostname + event and sends them in one batch about once a minute
 * (src/usage-buffer.ts → POST /api/events). No text and no full URLs are ever included.
 */

export const TRACK_MESSAGE = 'REWORDLY_TRACK';

/** Keep in sync with EVENTS in rewordly-web lib/metrics.ts (unknown events are dropped there). */
export type UsageEvent =
  | 'live_check'
  | 'live_fix'
  | 'live_fix_all'
  | 'live_ignore'
  | 'live_ignore_always'
  | 'live_dictionary'
  | 'live_badge'
  | 'live_limit'
  | 'rewrite'
  | 'rewrite_limit'
  | 'grammar'
  | 'grammar_limit';

export interface TrackMessage {
  type: typeof TRACK_MESSAGE;
  event: UsageEvent;
  count: number;
  chars: number;
}

/** Fire and forget: metrics must never get in the way of the feature itself. */
export function track(event: UsageEvent, count = 1, chars = 0): void {
  if (count <= 0) return;
  try {
    const message: TrackMessage = { type: TRACK_MESSAGE, event, count, chars };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Extension reloaded under this page: nothing to report to.
  }
}

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.test', '.example', '.invalid'];

/**
 * The site as recorded: hostname without "www.". Local and intranet hosts become 'private', so
 * company-internal names never leave the device. Null for pages that aren't websites.
 */
export function siteOf(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return 'private';
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return 'private';
  return host.startsWith('www.') ? host.slice(4) : host;
}
