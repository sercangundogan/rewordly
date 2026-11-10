/**
 * What the live checker tells the user about their plan, and when.
 * Kept quiet on purpose: nothing is shown while plenty of quota is left; a small
 * dot on the badge appears when it runs low; the limit card opens by itself at
 * most once a day. Everything else waits for the user to hover or click.
 */

import type { LimitInfo, QuotaInfo } from './api';

export interface AccountState {
  limit: LimitInfo | null;
  quota: QuotaInfo | null;
  /** Fixes the user applied today (shown as a reminder of value, never as a nag). */
  fixedToday: number;
}

export type CtaKind = 'login' | 'upgrade';

export interface Nudge {
  text: string;
  cta: { kind: CtaKind; label: string } | null;
}

/** "Low" below this share of the quota left. */
export const LOW_QUOTA_RATIO = 0.2;

const LOGIN = { kind: 'login', label: 'Log in' } as const;
const UPGRADE = { kind: 'upgrade', label: 'Go Pro' } as const;

function percentLeft(quota: QuotaInfo): number {
  return Math.max(0, Math.round((1 - quota.used / quota.limit) * 100));
}

export function isLow(account: AccountState): boolean {
  const q = account.quota;
  if (!q || q.tier === 'pro' || q.limit <= 0) return false;
  return 1 - q.used / q.limit <= LOW_QUOTA_RATIO;
}

/** Shown while quota is running low (in the issue card footer and the badge card). */
export function lowNudge(account: AccountState): Nudge | null {
  const q = account.quota;
  if (!q || !isLow(account)) return null;
  const left = percentLeft(q);
  return q.tier === 'anonymous'
    ? { text: `${left}% of your free trial left. Log in to keep checking for free.`, cta: LOGIN }
    : { text: `${left}% of today's free checks left. Pro has no daily limit.`, cta: UPGRADE };
}

/** Shown once checking has stopped. */
export function limitNudge(account: AccountState): Nudge {
  const limit = account.limit;
  const tier = account.quota?.tier ?? (limit?.requireLogin ? 'anonymous' : 'free');
  if (limit?.code === 'PAUSED') {
    return { text: 'Auto-check is taking a short break for free accounts. Pro keeps working.', cta: UPGRADE };
  }
  if (tier === 'anonymous') return { text: "Your free trial is over. Log in to keep checking — it's free.", cta: LOGIN };
  if (tier === 'free') return { text: "You've used today's free checks. Go Pro for unlimited checks, or continue tomorrow.", cta: UPGRADE };
  return { text: "You've reached this month's fair-use limit.", cta: null };
}

export function fixedTodayText(account: AccountState): string | null {
  const n = account.fixedToday;
  return n > 0 ? `You fixed ${n} mistake${n === 1 ? '' : 's'} with Rewordly today.` : null;
}
