/**
 * One FieldSession per editable field the user has focused. It owns the field's
 * text snapshot and issues, keeps issues glued to the text while the user types,
 * and decides which sentences to (re)check.
 *
 * Cost rules (every model call is paid for):
 * - only sentences that changed are sent (cached answers are reused everywhere);
 * - the sentence being typed waits until it is finished or the user pauses;
 * - in long texts only the part around the caret is checked automatically;
 * - a sentence changed by one of our own fixes is not sent again (see rememberAsChecked).
 */

import type { FieldAdapter } from './adapters';
import { getCached, requestCheck, setCached, type LimitInfo, type QuotaInfo } from './api';
import { looksSensitive } from './sensitive';
import { debug } from './targets';
import {
  diffText,
  isTerminated,
  protectedRanges,
  repeatsNeighbour,
  shiftIssues,
  splitUnits,
  toFieldIssues,
  touchesProtected,
  type FieldIssue,
  type TextUnit,
} from './text';

export type SessionStatus = 'idle' | 'checking' | 'done' | 'limit' | 'error';

export interface SessionHost {
  /** Called whenever issues or status change; the host schedules a render. */
  changed(session: FieldSession): void;
  isPaused(): boolean;
  reportLimit(limit: LimitInfo): void;
  reportQuota(quota: QuotaInfo): void;
  isIgnored(issue: FieldIssue): boolean;
  /** True while an IME (or a dead-key accent) is composing text: what is in the field is not final yet. */
  isComposing(): boolean;
}

/** Pause after the last keystroke before checking finished sentences. */
const TYPING_DEBOUNCE_MS = 800;
/** The unfinished sentence under the caret is checked only after this much idle time. */
const IDLE_MS = 2000;
/** While the user is typing inside a flagged word, hide its underline for this long. */
const CARET_GRACE_MS = 1500;
/** Server limits per request. */
const MAX_UNITS_PER_REQUEST = 30;
const MAX_CHARS_PER_REQUEST = 12000;
/** In long texts, only sentences within this window around the caret are checked automatically. */
const WINDOW_BEFORE_CARET = 2000;
/** After this many failed requests in a row, stop for a while instead of retrying forever (every try can cost the server money). */
const FAILURES_BEFORE_COOL_OFF = 6;
const COOL_OFF_MS = 2 * 60_000;
/** A sentence that fails on its own this many times (while other requests work) is set aside for a while: the server probably chokes on it. */
const UNIT_FAILURES_BEFORE_PARKING = 3;
const PARKED_MS = 5 * 60_000;
const WINDOW_AFTER_CARET = 1000;

export class FieldSession {
  text = '';
  status: SessionStatus = 'idle';
  /** True once a check has completed: from then on the badge keeps showing the last result while a new check runs. */
  hasResult = false;
  /** Sentences that look like secrets (see sensitive.ts), by hash: never sent. */
  private readonly sensitive = new Map<string, boolean>();
  /** Failed requests per sentence, and how many sentences go into one request while something keeps failing. */
  private readonly unitFailures = new Map<string, number>();
  /** Sentences set aside after failing on their own, by hash → when they may be tried again. */
  private readonly parked = new Map<string, number>();
  private maxBatch = MAX_UNITS_PER_REQUEST;
  private coolOffUntil = 0;
  /** When the current check started (0 when none is running). */
  checkingSince = 0;
  private issues: FieldIssue[] = [];
  private inflight = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastInputAt = 0;
  private failures = 0;
  private disposed = false;
  /**
   * Sentences as they were before one of our fixes was applied. The model is not always
   * consistent ("dass," → "dass", then "dass" → "dass,"), so a suggestion that would turn a
   * sentence back into one of these is dropped instead of sending the user round in circles.
   */
  private readonly reverted = new Set<string>();
  /** Fixes being applied: the editor may report the edit in several steps, don't check halfway. */
  private applying = 0;

  constructor(readonly adapter: FieldAdapter, private readonly host: SessionHost) {}

  get el() {
    return this.adapter.el;
  }

  /** Re-reads the field. `typed` marks user input (debounced check + caret grace). */
  sync(typed: boolean): void {
    if (this.disposed) return;
    const next = this.adapter.readText();
    if (typed) this.lastInputAt = Date.now();
    if (next === this.text) {
      if (typed) this.host.changed(this);
      return;
    }

    const diff = diffText(this.text, next);
    if (diff) this.issues = shiftIssues(this.issues, diff, next);
    this.text = next;
    this.rebuild();
    this.host.changed(this);
    this.schedule(typed ? TYPING_DEBOUNCE_MS : 150);
  }

  /** The caret moved (click, arrow keys): in long texts that can bring new sentences into the window. */
  caretMoved(): void {
    if (!this.timer && this.text.length > WINDOW_BEFORE_CARET + WINDOW_AFTER_CARET) this.schedule(TYPING_DEBOUNCE_MS);
  }

  /** Issues to draw right now. */
  visibleIssues(): FieldIssue[] {
    const typingRecently = Date.now() - this.lastInputAt < CARET_GRACE_MS;
    const caret = typingRecently ? this.adapter.caret() : null;
    return this.issues.filter(
      (issue) =>
        !this.host.isIgnored(issue) &&
        !(caret !== null && caret >= issue.offset && caret <= issue.offset + issue.length)
    );
  }

  /** True while the user is typing (the last input was less than `ms` ago). */
  typedWithin(ms: number): boolean {
    return Date.now() - this.lastInputAt < ms;
  }

  /** Milliseconds until the caret grace period ends (so the host can re-render then). */
  graceRemaining(): number {
    return Math.max(0, CARET_GRACE_MS - (Date.now() - this.lastInputAt));
  }

  /** Uses cached results for unchanged sentences; keeps shifted issues for the rest until rechecked. */
  private rebuild(): void {
    const next: FieldIssue[] = [];
    for (const unit of splitUnits(this.text)) {
      const cached = getCached(unit.hash);
      const end = unit.start + unit.text.length;
      const issues = cached
        ? this.keepIds(toFieldIssues(unit, cached))
        : this.issues.filter((i) => i.offset >= unit.start && i.offset + i.length <= end);
      const shielded = protectedRanges(unit.text).map(([from, to]): [number, number] => [unit.start + from, unit.start + to]);
      next.push(
        ...issues.filter(
          (i) =>
            !touchesProtected(i, shielded) &&
            !repeatsNeighbour(this.text, i.offset, i.length, i.replacements[0] ?? '') &&
            !this.undoesFix(unit, i)
        )
      );
    }
    this.issues = next;
  }

  /**
   * An issue that was already shown keeps its id when its sentence's results are re-read
   * (e.g. after a fix elsewhere in it), so "Fix all" and "Ignore" keep referring to it.
   */
  private keepIds(fresh: FieldIssue[]): FieldIssue[] {
    return fresh.map((issue) => {
      const shown = this.issues.find((o) => o.offset === issue.offset && o.length === issue.length && o.original === issue.original);
      return shown ? { ...issue, id: shown.id } : issue;
    });
  }

  private undoesFix(unit: TextUnit, issue: FieldIssue): boolean {
    if (this.reverted.size === 0) return false;
    const at = issue.offset - unit.start;
    const result = unit.text.slice(0, at) + (issue.replacements[0] ?? '') + unit.text.slice(at + issue.length);
    const undoes = this.reverted.has(normalize(result));
    if (undoes) debug('dropping a suggestion that would undo an applied fix', issue);
    return undoes;
  }

  schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
  }

  /** Sentences that should be checked now, nearest to the caret first. */
  private dueUnits(): { due: TextUnit[]; waiting: boolean } {
    const caret = this.adapter.caret() ?? this.text.length;
    const idle = Date.now() - this.lastInputAt >= IDLE_MS;
    const from = caret - WINDOW_BEFORE_CARET;
    const to = caret + WINDOW_AFTER_CARET;
    let waiting = false;
    const seen = new Set<string>();

    const due = splitUnits(this.text).filter((unit) => {
      const end = unit.start + unit.text.length;
      if (end < from || unit.start > to) return false;
      if (getCached(unit.hash) || this.inflight.has(unit.hash) || seen.has(unit.hash)) return false;
      if (this.isSensitive(unit)) return false;
      if ((this.parked.get(unit.hash) ?? 0) > Date.now()) return false;
      // The sentence being typed: wait until it is finished or the user pauses.
      const underCaret = caret >= unit.start && caret <= end + 1;
      if (underCaret && !idle && !isTerminated(unit.text)) {
        waiting = true;
        return false;
      }
      seen.add(unit.hash);
      return true;
    });

    const distance = (u: TextUnit) => (caret < u.start ? u.start - caret : Math.max(0, caret - (u.start + u.text.length)));
    return { due: due.sort((a, b) => distance(a) - distance(b)), waiting };
  }

  private isSensitive(unit: TextUnit): boolean {
    let verdict = this.sensitive.get(unit.hash);
    if (verdict === undefined) {
      if (this.sensitive.size > 2000) this.sensitive.clear();
      verdict = looksSensitive(unit.text);
      this.sensitive.set(unit.hash, verdict);
    }
    return verdict;
  }

  private async check(): Promise<void> {
    if (this.disposed) return;
    // Mid-composition the text in the field is not final (and would be sent half-typed).
    if (this.host.isComposing()) {
      this.schedule(300);
      return;
    }
    // Too many failures in a row: wait it out, whatever the user types meanwhile.
    if (Date.now() < this.coolOffUntil) {
      this.schedule(this.coolOffUntil - Date.now() + 50);
      return;
    }
    if (this.applying > 0) {
      this.schedule(100);
      return;
    }
    if (this.host.isPaused()) {
      this.setStatus('limit');
      return;
    }

    const { due, waiting } = this.dueUnits();
    if (waiting) this.schedule(Math.max(50, IDLE_MS - (Date.now() - this.lastInputAt)));
    if (due.length === 0) {
      this.setStatus(this.inflight.size > 0 ? 'checking' : 'done');
      return;
    }

    const batch: TextUnit[] = [];
    let chars = 0;
    for (const unit of due) {
      if (batch.length >= this.maxBatch || (batch.length > 0 && chars + unit.text.length > MAX_CHARS_PER_REQUEST)) break;
      batch.push(unit);
      chars += unit.text.length;
    }

    batch.forEach((u) => this.inflight.add(u.hash));
    this.setStatus('checking');
    debug(`checking ${batch.length} sentence(s), ${chars} chars`);
    const outcome = await requestCheck(batch.map((u) => ({ id: u.hash, text: u.text })));
    debug('check result:', outcome);
    batch.forEach((u) => this.inflight.delete(u.hash));
    if (this.disposed) return;

    if (outcome.kind === 'error') {
      this.failures++;
      this.isolateFailure(batch);
      if (this.failures >= FAILURES_BEFORE_COOL_OFF) {
        this.failures = 0;
        this.coolOffUntil = Date.now() + COOL_OFF_MS;
        debug(`${FAILURES_BEFORE_COOL_OFF} requests failed in a row: pausing checks for ${COOL_OFF_MS / 1000}s`);
      }
      this.setStatus('error');
      // Back off: 2s, 4s, 8s ... capped at 60s. Any new typing reschedules sooner.
      this.schedule(Math.min(60000, 1000 * 2 ** this.failures));
      return;
    }

    // Cached answers come back even when the quota is used up.
    for (const [hash, issues] of outcome.results) setCached(hash, issues);
    if (outcome.quota) this.host.reportQuota(outcome.quota);

    if (outcome.kind === 'limit') {
      this.rebuild();
      this.host.reportLimit(outcome.limit);
      this.setStatus('limit');
      return;
    }

    this.failures = 0;
    this.maxBatch = MAX_UNITS_PER_REQUEST;
    for (const u of batch) this.unitFailures.delete(u.hash);
    this.hasResult = true;
    // A sentence missing from the reply is treated as clean so we never re-request it in a loop.
    for (const u of batch) if (!outcome.results.has(u.hash)) setCached(u.hash, []);
    this.rebuild();
    this.status = 'checking';
    this.host.changed(this);
    // More sentences left (long texts) or text changed meanwhile: keep going.
    this.schedule(0);
  }

  /**
   * A failed request tells nothing about which sentence caused it. Ask for fewer sentences next time, so a
   * single one the server cannot handle stops holding the rest back; alone, it gets a few tries and is then set aside.
   */
  private isolateFailure(batch: TextUnit[]): void {
    this.maxBatch = Math.max(1, Math.floor(batch.length / 2));
    if (batch.length !== 1) return;
    const unit = batch[0]!;
    const failed = (this.unitFailures.get(unit.hash) ?? 0) + 1;
    this.unitFailures.set(unit.hash, failed);
    // Without any success so far this looks like an outage, not like one bad sentence: the cool-off handles that.
    if (failed < UNIT_FAILURES_BEFORE_PARKING || !this.hasResult) return;
    debug('this sentence keeps failing on its own: setting it aside for a while', unit.text.slice(0, 60));
    this.parked.set(unit.hash, Date.now() + PARKED_MS);
    this.unitFailures.delete(unit.hash);
    this.maxBatch = MAX_UNITS_PER_REQUEST;
    this.failures = 0;
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.checkingSince = status === 'checking' ? Date.now() : 0;
    this.host.changed(this);
  }

  /** Applies a replacement; false when the text moved under us or the editor refused it. */
  async apply(issue: FieldIssue, replacement: string): Promise<boolean> {
    if (this.host.isComposing()) return false;
    this.sync(false);
    const current = this.issues.find((i) => i.id === issue.id);
    if (!current || this.text.slice(current.offset, current.offset + current.length) !== current.original) {
      return false;
    }
    let start = current.offset;
    let end = current.offset + current.length;
    // Sentences are checked on their own, so a deletion doesn't include the space that separates
    // it from the previous sentence; take it along so no double or trailing space is left behind.
    if (replacement === '') {
      if (this.text[start - 1] === ' ' && (end === this.text.length || /[\s.,!?;:]/.test(this.text[end]!))) start--;
      else if (this.text[end] === ' ' && (start === 0 || this.text[start - 1] === '\n')) end++;
    }
    const unit = splitUnits(this.text).find((u) => u.start <= start && end <= u.start + u.text.length);
    this.applying++;
    try {
      const ok = await this.adapter.replace(start, end, replacement);
      if (ok && unit) this.reverted.add(normalize(unit.text));
      this.sync(false);
      if (ok) {
        // The fix itself is done, whatever the text diff made of it: "yanlışın" → "yanlışın var"
        // reads as an insertion after the word, which would leave the word's issue standing.
        const written = start + replacement.length;
        this.issues = this.issues.filter((i) => !(i.offset < Math.max(written, start + 1) && start < i.offset + i.length));
        this.rememberAsChecked(start, written);
      }
      return ok;
    } finally {
      this.applying--;
    }
  }

  /**
   * After one of our fixes the sentence's other issues are still known (shifted along with the
   * text), so the changed sentence is recorded as checked with those instead of being sent again.
   * Re-sending it costs a request and lets the model, which is not fully consistent, come up
   * with new suggestions right after "Fix all" turned the badge green.
   */
  private rememberAsChecked(from: number, to: number): void {
    for (const unit of splitUnits(this.text)) {
      const end = unit.start + unit.text.length;
      if (end < from || unit.start > to || getCached(unit.hash)) continue;
      const remaining = this.issues
        .filter((i) => i.offset >= unit.start && i.offset + i.length <= end)
        .map(({ id: _id, ...issue }) => ({ ...issue, offset: issue.offset - unit.start }));
      setCached(unit.hash, remaining);
    }
    this.rebuild();
    this.host.changed(this);
  }

  /** Applies every visible issue's first suggestion, last to first so earlier offsets stay valid. */
  async applyAll(): Promise<number> {
    let applied = 0;
    const issues = this.visibleIssues().sort((a, b) => b.offset - a.offset);
    for (const issue of issues) {
      const replacement = issue.replacements[0];
      if (replacement !== undefined && (await this.apply(issue, replacement))) applied++;
    }
    return applied;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.adapter.dispose();
  }
}

function normalize(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim();
}
