/**
 * Rewordly live checker: underlines spelling/grammar mistakes as the user types,
 * in any textarea, text input or contenteditable editor (incl. open shadow DOM
 * and iframes; this script runs in every frame).
 *
 * Flow: focus/input → FieldSession reads text → unchanged paragraphs come from
 * cache, changed ones are checked after a typing pause → Overlay draws.
 */

import { API_BASE } from '../config';
import { createAdapter } from './adapters';
import type { AccountState, CtaKind } from './account';
import { reportIgnored, type LimitInfo, type QuotaInfo } from './api';
import { currentPage, isDisabledHere } from './disabled';
import { BurstGuard } from './guard';
import { Overlay, SCROLL_SETTLE_MS } from './overlay';
import { restoreNativeSpellcheck, suppressNativeSpellcheck } from './native-spellcheck';
import { badgeRuleFor } from './placements';
import { track } from '../usage';
import { FieldSession, type SessionHost } from './session';
import { debug, isSupportedPage, resolveTarget, type LiveTarget } from './targets';
import type { FieldIssue } from './text';

const ENABLED_KEY = 'rewordlyProactiveEnabled';
const DICTIONARY_KEY = 'rewordlyDictionary';
/** chrome.storage.local: suggestions (original → replacement) the user chose to never see again. */
const IGNORED_KEY = 'rewordlyIgnoredSuggestions';
const MAX_IGNORED = 500;
const COMPOSITION_TIMEOUT_MS = 15_000;
const DISABLED_PAGES_KEY = 'rewordlyDisabledPages';
const SESSION_KEY = 'rewordly_session';
/** chrome.storage.local: { d: 'YYYY-MM-DD', n } fixes applied today. */
const FIXES_KEY = 'rewordlyFixesToday';
/** chrome.storage.local: the day the limit card last opened by itself. */
const LIMIT_NOTICE_KEY = 'rewordlyLimitNoticeDay';

/** Fields we keep underlines for after they lose focus. */
const MAX_SESSIONS = 6;
const HOVER_HIDE_MS = 150;
/** An editor turning spellcheck back on is answered after this pause, so it can never turn into a tight loop. */
const SPELLCHECK_SYNC_MS = 100;
/**
 * Runaway guard: more than this many DOM-observer callbacks within a second is not normal use
 * (typing and pasting produce a few dozen at most) but a page and the extension undoing each
 * other's changes, which can freeze the tab. Live checking then stops on this page.
 */
const MAX_MUTATION_CALLBACKS_PER_SECOND = 600;
/**
 * With a card open, another flagged word takes over only after the pointer rests on it this long,
 * so crossing the next line's word on the way to the card doesn't swap the card under the pointer.
 */
const HOVER_SWITCH_MS = 400;
/** Catches programmatic value changes (e.g. a chat box cleared after send) that fire no event. */
const POLL_MS = 500;

class LiveChecker implements SessionHost {
  private readonly sessions = new Map<LiveTarget, FieldSession>();
  private focused: FieldSession | null = null;
  private overlay: Overlay | null = null;
  private enabled = false;
  private globallyEnabled = true;
  private pageDisabled = false;
  /** An IME or dead key is composing text (see isComposing). */
  private composingSince = 0;
  private dictionary = new Set<string>();
  private ignoredAlways = new Set<string>();
  /** Dismissed issue ids for this page view. */
  private readonly dismissed = new Set<string>();
  private account: AccountState = { limit: null, quota: null, fixedToday: 0 };
  private renderQueued = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private switchTimer: ReturnType<typeof setTimeout> | null = null;
  private switchTo: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private mutationObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Switches the browser's spellcheck off again after an editor turned it back on (never faster than SPELLCHECK_SYNC_MS). */
  private spellcheckObserver: MutationObserver | null = null;
  private spellcheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mutationGuard = new BurstGuard(MAX_MUTATION_CALLBACKS_PER_SECOND, 1000);
  /** Set once the runaway guard has stopped live checking on this page. */
  private tripped = false;
  private pointer = { x: -1, y: -1 };

  async start(): Promise<void> {
    if (!isSupportedPage()) {
      debug('unsupported page, not starting');
      return;
    }
    const stored = await chrome.storage.sync.get([ENABLED_KEY, DICTIONARY_KEY, DISABLED_PAGES_KEY]);
    const local = await chrome.storage.local.get([FIXES_KEY, IGNORED_KEY]);
    this.ignoredAlways = new Set((local[IGNORED_KEY] as string[] | undefined) ?? []);
    const fixes = local[FIXES_KEY] as { d: string; n: number } | undefined;
    if (fixes?.d === new Date().toISOString().slice(0, 10)) this.account = { ...this.account, fixedToday: fixes.n };
    this.dictionary = new Set((stored[DICTIONARY_KEY] as string[] | undefined) ?? []);
    this.globallyEnabled = stored[ENABLED_KEY] !== false;
    this.pageDisabled = isDisabledHere(stored[DISABLED_PAGES_KEY] as string[] | undefined, currentPage());
    debug('starting', { enabled: this.globallyEnabled, pageDisabled: this.pageDisabled, frame: window === top ? 'top' : 'iframe' });
    this.setEnabled(this.globallyEnabled && !this.pageDisabled);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[ENABLED_KEY]) {
        this.globallyEnabled = changes[ENABLED_KEY].newValue !== false;
        this.setEnabled(this.globallyEnabled && !this.pageDisabled);
      }
      // "Disable Rewordly on this page" takes effect at once, not after the next reload.
      if (area === 'sync' && changes[DISABLED_PAGES_KEY]) {
        this.pageDisabled = isDisabledHere(changes[DISABLED_PAGES_KEY].newValue as string[] | undefined, currentPage());
        this.setEnabled(this.globallyEnabled && !this.pageDisabled);
      }
      if (area === 'sync' && changes[DICTIONARY_KEY]) {
        this.dictionary = new Set((changes[DICTIONARY_KEY].newValue as string[] | undefined) ?? []);
        this.requestRender();
      }
      // Logging in / out changes the plan: forget the old quota, and retry if we were stopped.
      if (area === 'local' && changes[SESSION_KEY]) {
        const wasLimited = this.account.limit !== null;
        this.account = { ...this.account, limit: null, quota: null };
        this.requestRender();
        if (!wasLimited) return;
        this.sessions.forEach((s) => s.schedule(0));
      }
    });
  }

  private setEnabled(enabled: boolean): void {
    if (this.tripped && enabled) return;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.overlay = new Overlay({
        apply: (s, i, r) => this.apply(s, i, r),
        applyAll: (s) =>
          void s.applyAll().then((applied) => {
            track('live_fix_all');
            track('live_fix', applied);
            this.requestRender();
          }),
        ignore: (_s, i) => {
          track('live_ignore');
          reportIgnored(i);
          this.dismiss(i);
        },
        ignoreAlways: (_s, i) => {
          track('live_ignore_always');
          reportIgnored(i);
          void this.ignoreAlwaysPersist(i);
        },
        addToDictionary: (_s, i) => {
          track('live_dictionary');
          return this.addToDictionary(i.original);
        },
        badgeClicked: () => track('live_badge'),
        openAccountAction: (kind) => this.openAccountAction(kind),
      });
      this.listen(true);
      // A field may already be focused when we start (autofocus, extension reload).
      const active = deepActiveElement();
      if (active) this.onFocus({ composedPath: () => [active] } as unknown as Event);
    } else {
      this.listen(false);
      this.sessions.forEach((s) => {
        restoreNativeSpellcheck(s.el);
        s.dispose();
      });
      this.sessions.clear();
      this.focused = null;
      this.overlay?.destroy();
      this.overlay = null;
    }
  }

  private readonly onFocus = (event: Event): void => {
    if (this.overlay?.isOwnEvent(event)) return;
    const target = resolveTarget(event);
    if (!target) return;
    const session = this.sessionFor(target);
    this.focus(session);
    session.sync(false);
    this.requestRender();
  };

  private readonly onInput = (event: Event): void => {
    const target = resolveTarget(event);
    if (!target) return;
    const session = this.sessionFor(target);
    if (session !== this.focused) this.focus(session);
    this.overlay?.hideCard();
    session.sync(true);
  };

  private readonly onScrollOrResize = (event: Event): void => {
    // A scroller that has nothing to do with our fields (a message list) moves nothing of ours.
    if (event.type === 'scroll' && this.overlay && !this.overlay.noteScroll(event.target)) return;
    this.requestRender();
    // Underlines hidden during a scroll come back once it stops.
    if (this.scrollSettleTimer) clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = setTimeout(() => this.requestRender(), SCROLL_SETTLE_MS + 30);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
    const overlay = this.overlay;
    if (!overlay) return;
    // On the card (which may cover the next line's words): it stays, whatever is underneath.
    if (overlay.isOverCard(event.clientX, event.clientY)) {
      this.clearHoverTimers();
      return;
    }
    const hit = overlay.hitTest(event.clientX, event.clientY);
    if (hit && (!overlay.isCardOpen() || overlay.isCardFor(hit))) {
      // Open the hovered word's card right away, as a click would.
      this.clearHoverTimers();
      this.openCardAtPointer();
    } else if (hit) {
      // Another word while a card is open: switch once the pointer rests on it.
      if (this.switchTimer && this.switchTo === hit.issue.id) return;
      this.clearHoverTimers();
      this.switchTo = hit.issue.id;
      this.switchTimer = setTimeout(() => {
        this.switchTimer = null;
        const now = overlay.hitTest(this.pointer.x, this.pointer.y);
        if (now && now.issue.id === hit.issue.id && !overlay.isOverCard(this.pointer.x, this.pointer.y)) {
          this.clearHoverTimers();
          this.openCardAtPointer();
        }
      }, HOVER_SWITCH_MS);
    } else if (overlay.isCardOpen() && !overlay.isCardPinned()) {
      // Leaving the word: keep a hover card briefly so the pointer can travel onto it.
      // (A card opened by a click or the badge stays put; see Overlay.isCardPinned.)
      if (this.hoverTimer) return;
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        if (overlay.isCardPinned()) return;
        if (!overlay.isOverCard(this.pointer.x, this.pointer.y) && !overlay.hitTest(this.pointer.x, this.pointer.y)) {
          overlay.hideCard();
          this.requestRender();
        }
      }, HOVER_HIDE_MS);
    }
  };

  private clearHoverTimers(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.switchTimer) clearTimeout(this.switchTimer);
    this.hoverTimer = null;
    this.switchTimer = null;
  }

  /** Click inside a flagged word opens its card immediately; clicks elsewhere close it. */
  private readonly onPointerDown = (event: PointerEvent): void => {
    const overlay = this.overlay;
    if (!overlay || overlay.isOwnEvent(event)) return;
    if (overlay.hitTest(event.clientX, event.clientY)) {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.clearHoverTimers();
      setTimeout(() => this.openCardAtPointer(true), 0);
    } else if (overlay.isCardOpen()) {
      overlay.hideCard();
      this.requestRender();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.overlay?.isCardOpen()) {
      this.overlay.hideCard();
      this.requestRender();
    }
  };

  private readonly onSelectionChange = (): void => {
    if (!this.focused) return;
    this.focused.caretMoved();
    this.requestRender();
  };

  private readonly onCompositionStart = (): void => {
    this.composingSince = Date.now();
  };

  private readonly onCompositionEnd = (): void => {
    this.composingSince = 0;
    // What was composed is final now: check it after the usual pause.
    this.focused?.schedule(800);
  };

  private listen(on: boolean): void {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('focusin', this.onFocus, true);
    document[method]('input', this.onInput, true);
    document[method]('scroll', this.onScrollOrResize, { capture: true, passive: true } as AddEventListenerOptions);
    document[method]('pointermove', this.onPointerMove as EventListener, { capture: true, passive: true } as AddEventListenerOptions);
    document[method]('pointerdown', this.onPointerDown as EventListener, true);
    document[method]('keydown', this.onKeyDown as EventListener, true);
    document[method]('selectionchange', this.onSelectionChange);
    document[method]('compositionstart', this.onCompositionStart, true);
    document[method]('compositionend', this.onCompositionEnd, true);
    window[method]('resize', this.onScrollOrResize, { passive: true } as AddEventListenerOptions);

    if (on) {
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
      this.resizeObserver = new ResizeObserver(() => this.requestRender());
      this.spellcheckObserver = new MutationObserver(() => {
        this.noteMutationBurst();
        if (this.spellcheckTimer) return;
        this.spellcheckTimer = setTimeout(() => {
          this.spellcheckTimer = null;
          this.sessions.forEach((s) => this.syncNativeSpellcheck(s));
        }, SPELLCHECK_SYNC_MS);
      });
      this.mutationObserver = new MutationObserver(() => {
        this.noteMutationBurst();
        this.focused?.sync(false);
        this.requestRender();
      });
    } else {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.resizeObserver?.disconnect();
      this.spellcheckObserver?.disconnect();
      this.spellcheckObserver = null;
      if (this.spellcheckTimer) clearTimeout(this.spellcheckTimer);
      this.spellcheckTimer = null;
      this.mutationObserver?.disconnect();
      this.pollTimer = null;
      this.resizeObserver = null;
      this.mutationObserver = null;
    }
  }

  private sessionFor(target: LiveTarget): FieldSession {
    let session = this.sessions.get(target);
    if (!session) {
      debug('attached to field', target, { badgeRule: badgeRuleFor(target, location.hostname)?.id ?? 'default' });
      session = new FieldSession(createAdapter(target, this.overlay!.mirrors), this);
      this.sessions.set(target, session);
      this.syncNativeSpellcheck(session);
      this.spellcheckObserver?.observe(target, { attributes: true, attributeFilter: ['spellcheck'], subtree: true });
      this.evict();
    }
    return session;
  }

  private focus(session: FieldSession): void {
    if (this.focused === session) return;
    this.focused = session;
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.resizeObserver?.observe(session.el);
    // Editors re-render asynchronously and some changes (undo, paste, programmatic) fire no input event.
    if (!(session.el instanceof HTMLTextAreaElement || session.el instanceof HTMLInputElement)) {
      this.mutationObserver?.observe(session.el, { characterData: true, childList: true, subtree: true });
    }
  }

  /** Drops sessions for removed fields and the oldest ones beyond the cap. */
  private evict(): void {
    for (const [el, session] of this.sessions) {
      const tooMany = this.sessions.size > MAX_SESSIONS && session !== this.focused;
      if (!el.isConnected || tooMany) {
        restoreNativeSpellcheck(el);
        session.dispose();
        this.sessions.delete(el);
        if (this.focused === session) this.focused = null;
      }
    }
  }

  private poll(): void {
    this.evict();
    if (document.visibilityState !== 'visible') return;
    this.focused?.sync(false);
    this.sessions.forEach((s) => this.syncNativeSpellcheck(s));
    // Modals, dropdowns and sticky headers can cover a field without any event on it;
    // re-rendering re-checks what is covered (see Overlay.isUncovered).
    if (this.sessions.size > 0) this.requestRender();
  }

  /** Our underlines replace the browser's squiggles, but only while we are actually checking. */
  private syncNativeSpellcheck(session: FieldSession): void {
    if (this.isPaused()) {
      restoreNativeSpellcheck(session.el);
      return;
    }
    for (const el of suppressNativeSpellcheck(session.el)) {
      debug("the page keeps turning the browser's spellcheck back on; leaving it as the page wants it on", el);
    }
  }

  /** Counts observer callbacks (see MAX_MUTATION_CALLBACKS_PER_SECOND) and stops everything if they run away. */
  private noteMutationBurst(): void {
    if (!this.mutationGuard.hit() || this.tripped) return;
    this.tripped = true;
    this.setEnabled(false);
    console.warn("[Rewordly live] stopped on this page: it and the extension kept undoing each other's changes. Reload the page to try again.");
  }

  private openCardAtPointer(pinned = false): void {
    const hit = this.overlay?.hitTest(this.pointer.x, this.pointer.y);
    if (!hit || !this.overlay) return;
    const anchor = hit.rects.find((r) => this.pointer.y >= r.top - 2 && this.pointer.y <= r.bottom + 3) ?? hit.rects[0]!;
    this.overlay.showCard(hit.session, hit.issue, hit.session.visibleIssues().length, anchor, pinned);
    this.requestRender();
  }

  // --- SessionHost ---------------------------------------------------------

  changed(): void {
    this.requestRender();
  }

  /** Composition that never ends (a page that swallows compositionend) must not stop checking for good. */
  isComposing(): boolean {
    return this.composingSince > 0 && Date.now() - this.composingSince < COMPOSITION_TIMEOUT_MS;
  }

  isPaused(): boolean {
    return this.account.limit !== null;
  }

  reportLimit(limit: LimitInfo): void {
    const first = this.account.limit === null;
    if (first) track('live_limit');
    this.account = { ...this.account, limit };
    this.sessions.forEach((s) => this.syncNativeSpellcheck(s));
    this.requestRender();
    if (first && this.focused) void this.announceLimitOncePerDay(this.focused);
  }

  reportQuota(quota: QuotaInfo): void {
    this.account = { ...this.account, quota };
    this.requestRender();
  }

  /** The limit card opens by itself at most once a day; after that only the badge shows it. */
  private async announceLimitOncePerDay(session: FieldSession): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const stored = await chrome.storage.local.get(LIMIT_NOTICE_KEY);
    if (stored[LIMIT_NOTICE_KEY] === today) return;
    await chrome.storage.local.set({ [LIMIT_NOTICE_KEY]: today });
    // After the render that shows the badge, so the card can anchor to it.
    requestAnimationFrame(() => requestAnimationFrame(() => this.overlay?.announceLimit(session)));
  }

  isIgnored(issue: FieldIssue): boolean {
    if (this.dismissed.has(issue.id) || this.ignoredAlways.has(suggestionKey(issue))) return true;
    return issue.type === 'spelling' && this.dictionary.has(issue.original.toLowerCase());
  }

  // --- actions -------------------------------------------------------------

  private async apply(session: FieldSession, issue: FieldIssue, replacement: string): Promise<void> {
    const ok = await session.apply(issue, replacement);
    if (ok) {
      track('live_fix');
      void this.countFix();
    }
    // The text moved or the editor refused the edit: drop the stale suggestion rather than retry blindly.
    if (!ok) this.dismiss(issue);
    this.requestRender();
  }

  private dismiss(issue: FieldIssue): void {
    this.dismissed.add(issue.id);
    this.requestRender();
  }

  private async ignoreAlwaysPersist(issue: FieldIssue): Promise<void> {
    this.ignoredAlways.add(suggestionKey(issue));
    this.dismissed.add(issue.id);
    this.requestRender();
    await chrome.storage.local.set({ [IGNORED_KEY]: Array.from(this.ignoredAlways).slice(-MAX_IGNORED) });
  }

  private async addToDictionary(word: string): Promise<void> {
    this.dictionary.add(word.toLowerCase());
    this.requestRender();
    await chrome.storage.sync.set({ [DICTIONARY_KEY]: Array.from(this.dictionary).slice(-2000) });
  }

  private openAccountAction(kind: CtaKind): void {
    const url = kind === 'login' ? `${API_BASE}/login` : `${API_BASE}/dashboard?upgrade=1`;
    void chrome.runtime.sendMessage({ type: 'OPEN_TAB', url }).catch(() => undefined);
  }

  private async countFix(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const stored = (await chrome.storage.local.get(FIXES_KEY))[FIXES_KEY] as { d: string; n: number } | undefined;
    const n = (stored?.d === today ? stored.n : 0) + 1;
    this.account = { ...this.account, fixedToday: n };
    await chrome.storage.local.set({ [FIXES_KEY]: { d: today, n } });
  }


  // --- rendering -----------------------------------------------------------

  private requestRender(): void {
    if (this.renderQueued || !this.overlay) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.overlay) return;
      const sessions = Array.from(this.sessions.values()).filter((s) => s.el.isConnected);
      this.overlay.render(sessions, this.focused, this.account);

      // Underlines hidden under the caret come back once the user stops typing in that word,
      // and the "all fixed" ✓ goes away on time even if nothing else happens on the page.
      const waits = [this.focused?.graceRemaining() ?? 0, this.focused?.clearedRemaining() ?? 0].filter((ms) => ms > 0);
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = waits.length > 0 ? setTimeout(() => this.requestRender(), Math.min(...waits) + 20) : null;
    });
  }
}

/** What "always ignore" remembers: the word and what it would be changed to, so other mistakes in that word still show. */
function suggestionKey(issue: FieldIssue): string {
  return `${issue.original.toLowerCase()}→${(issue.replacements[0] ?? '').toLowerCase()}`;
}

/** document.activeElement, descending into open shadow roots. */
function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active && active !== document.body ? active : null;
}

if (document.documentElement instanceof HTMLElement && document.contentType === 'text/html') {
  void new LiveChecker().start();
}
