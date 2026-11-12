/**
 * Live check transport. Requests go through the background service worker so
 * page CSP/CORS never interferes, auth (incl. token refresh) lives in one place,
 * and results are cached persistently there for every tab (see background.ts).
 */

import { sanitizeIssues, type ParagraphIssue } from './text';

export const LIVE_CHECK_MESSAGE = 'REWORDLY_LIVE_CHECK';
export const IGNORED_MESSAGE = 'REWORDLY_IGNORED';

export type QuotaTier = 'anonymous' | 'free' | 'pro';

export interface QuotaInfo {
  tier: QuotaTier;
  period: 'lifetime' | 'day' | 'month';
  used: number;
  limit: number;
}

export interface LimitInfo {
  /** LIMIT_REACHED: the user's quota is used up. PAUSED: the service-wide budget for free use is. */
  code: 'LIMIT_REACHED' | 'PAUSED';
  requireLogin: boolean;
  requirePayment: boolean;
  message: string;
}

export interface LiveCheckRequest {
  type: typeof LIVE_CHECK_MESSAGE;
  paragraphs: Array<{ id: string; text: string }>;
}

export interface LiveCheckReply {
  ok: boolean;
  status: number;
  data: {
    results?: Array<{ id: string; language: string; issues: ParagraphIssue[] }>;
    quota?: QuotaInfo | null;
    code?: string;
    requireLogin?: boolean;
    requirePayment?: boolean;
    message?: string;
  };
}

export interface IgnoredMessage {
  type: typeof IGNORED_MESSAGE;
  fp: string;
}

/**
 * Tells the server this suggestion was ignored. When enough different people ignore the same
 * one, the server stops returning it. Only the opaque id is sent, never text. Fire and forget.
 */
export function reportIgnored(issue: ParagraphIssue): void {
  if (!issue.fp) return;
  try {
    const message: IgnoredMessage = { type: IGNORED_MESSAGE, fp: issue.fp };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Extension reloaded under this page: nothing to report to.
  }
}

export type CheckOutcome =
  | { kind: 'ok'; results: Map<string, ParagraphIssue[]>; quota: QuotaInfo | null }
  | { kind: 'limit'; results: Map<string, ParagraphIssue[]>; quota: QuotaInfo | null; limit: LimitInfo }
  | { kind: 'error' };

export async function requestCheck(paragraphs: Array<{ id: string; text: string }>): Promise<CheckOutcome> {
  let reply: LiveCheckReply | undefined;
  try {
    reply = await chrome.runtime.sendMessage<LiveCheckRequest, LiveCheckReply>({
      type: LIVE_CHECK_MESSAGE,
      paragraphs,
    });
  } catch {
    // Extension was reloaded/updated: this content script is orphaned.
    return { kind: 'error' };
  }
  if (!reply) return { kind: 'error' };

  const results = new Map<string, ParagraphIssue[]>();
  const texts = new Map(paragraphs.map((p) => [p.id, p.text]));
  const replied = Array.isArray(reply.data.results) ? reply.data.results : [];
  for (const r of replied) {
    // Only what was asked for, and only what holds up against that sentence.
    const text = r && typeof r.id === 'string' ? texts.get(r.id) : undefined;
    if (text !== undefined) results.set(r.id, sanitizeIssues(text, r.issues));
  }
  const quota = reply.data.quota ?? null;

  const code = reply.data.code;
  if (reply.status === 402 && (code === 'LIMIT_REACHED' || code === 'PAUSED')) {
    return {
      kind: 'limit',
      results,
      quota,
      limit: {
        code,
        requireLogin: reply.data.requireLogin === true,
        requirePayment: reply.data.requirePayment === true,
        message: reply.data.message ?? 'Daily auto-check limit reached.',
      },
    };
  }
  if (!reply.ok || !Array.isArray(reply.data.results)) return { kind: 'error' };
  return { kind: 'ok', results, quota };
}

/** In-memory results by sentence hash for this frame (the persistent copy lives in background). */
const CACHE_LIMIT = 1000;
const cache = new Map<string, ParagraphIssue[]>();

export function getCached(hash: string): ParagraphIssue[] | undefined {
  const hit = cache.get(hash);
  if (hit) {
    // Refresh recency.
    cache.delete(hash);
    cache.set(hash, hit);
  }
  return hit;
}

export function setCached(hash: string, issues: ParagraphIssue[]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(hash, issues);
}
