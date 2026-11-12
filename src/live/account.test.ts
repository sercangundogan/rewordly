import { describe, expect, it } from 'vitest';
import { isLow, limitNudge, lowNudge, type AccountState } from './account';

const account = (quota: AccountState['quota'], limit: AccountState['limit'] = null): AccountState => ({ quota, limit, fixedToday: 0 });

describe('account nudges', () => {
  it('stays quiet while plenty of quota is left', () => {
    const a = account({ tier: 'anonymous', period: 'lifetime', used: 5000, limit: 15000 });
    expect(isLow(a)).toBe(false);
    expect(lowNudge(a)).toBeNull();
  });

  it('nudges anonymous users to log in when the trial runs low', () => {
    const nudge = lowNudge(account({ tier: 'anonymous', period: 'lifetime', used: 13000, limit: 15000 }));
    expect(nudge?.cta?.kind).toBe('login');
    expect(nudge?.text).toContain('13%');
  });

  it('nudges free users to upgrade, never Pro users', () => {
    expect(lowNudge(account({ tier: 'free', period: 'day', used: 55000, limit: 60000 }))?.cta?.kind).toBe('upgrade');
    expect(lowNudge(account({ tier: 'pro', period: 'month', used: 2_999_000, limit: 3_000_000 }))).toBeNull();
  });

  it('explains why checking stopped', () => {
    const limit = { code: 'LIMIT_REACHED' as const, requireLogin: true, requirePayment: false, message: '' };
    expect(limitNudge(account(null, limit)).cta?.kind).toBe('login');
    const paused = { code: 'PAUSED' as const, requireLogin: false, requirePayment: true, message: '' };
    expect(limitNudge(account({ tier: 'free', period: 'day', used: 0, limit: 60000 }, paused)).text).toContain('break');
  });
});
