/**
 * Counts events and says when there are too many within a window.
 *
 * The count is reset by a timer, not by comparing timestamps: a runaway loop (the page and the
 * extension undoing each other's changes) never yields to timers, so it keeps counting up and
 * trips the guard instead of freezing the tab.
 */
export class BurstGuard {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Counts one event; true once more than `limit` happened within the window. */
  hit(): boolean {
    if (++this.count > this.limit) return true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.count = 0;
      }, this.windowMs);
    }
    return false;
  }
}
