import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BurstGuard } from './guard';

describe('BurstGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets normal activity through, in every window', () => {
    const guard = new BurstGuard(5, 1000);
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) expect(guard.hit()).toBe(false);
      vi.advanceTimersByTime(1000);
    }
  });

  it('trips on a burst within one window', () => {
    const guard = new BurstGuard(5, 1000);
    for (let i = 0; i < 5; i++) guard.hit();
    expect(guard.hit()).toBe(true);
  });

  it('trips on a loop that never yields to timers, however long it runs', () => {
    const guard = new BurstGuard(100, 1000);
    let tripped = false;
    for (let i = 0; i < 10_000 && !tripped; i++) tripped = guard.hit();
    expect(tripped).toBe(true);
  });
});
