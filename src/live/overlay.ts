/**
 * Everything the live checker draws: wavy underlines, the per-field status badge,
 * and the suggestion card. It all lives in one closed shadow root attached to
 * <html>, so page CSS can't touch it and the page DOM is never modified.
 *
 * Underlines are positioned from Range rects every animation frame something
 * moves (scroll, resize, typing); they are never inserted into the editor.
 * They are laid out in document coordinates, so a page scroll carries them
 * along with the text instead of the redraw catching up a frame later.
 *
 * Fields inside their own scroll area (a side panel, a chat log) need the same
 * for that area's scroll, which only content of the area gets. For those we add
 * one empty, zero-size <rewordly-anchor> element inside the area, next to the
 * field's content, and draw that field's underlines and badge in its shadow root.
 */

import { fixedTodayText, isLow, limitNudge, lowNudge, type AccountState, type CtaKind, type Nudge } from './account';
import { badgeFrame, badgePlacementFor, chooseBadgeSpot, type BadgeAnchor, type BadgeSpot } from './placements';
import type { FieldSession } from './session';
import { debug } from './targets';

declare const process: { env: Record<string, string | undefined> };
import type { FieldIssue, IssueType } from './text';

export interface OverlayActions {
  apply(session: FieldSession, issue: FieldIssue, replacement: string): Promise<void>;
  applyAll(session: FieldSession): void;
  ignore(session: FieldSession, issue: FieldIssue): void;
  addToDictionary(session: FieldSession, issue: FieldIssue): Promise<void>;
  /** Never show this suggestion again (spelling mistakes have the dictionary instead). */
  ignoreAlways(session: FieldSession, issue: FieldIssue): void;
  openAccountAction(kind: CtaKind): void;
  badgeClicked(): void;
}

interface FieldLayer {
  clip: HTMLDivElement;
  marks: Map<string, HTMLDivElement>;
  badge: HTMLButtonElement;
  /** Container holding this field's anchor, or null when drawn in the main overlay. */
  anchoredIn: Element | null;
  /** Where the badge sits now; kept while still free so it doesn't jump around (see placements.ts). */
  badgeAnchor: BadgeAnchor | null;
  /** Field size the anchor was chosen for: a resize starts the choice over. */
  badgeFieldSize: string;
  /** Text positions relative to the field's top-left, read at most every TEXT_RECTS_TTL_MS. */
  textRects: { at: number; rel: number[][] } | null;
  /** The underlines stay hidden until this time (see Overlay.noteScroll). */
  scrollingUntil: number;
}

/** How long after the last scroll event the underlines stay hidden. */
export const SCROLL_SETTLE_MS = 140;

/** A clean field's ✓ stays this long, then fades: the badge only stays for what the user may act on. */
const CLEAN_VISIBLE_MS = 2500;
/** The spinner shows only for a first check that takes this long: quick checks while typing never flash it. */
const SPINNER_DELAY_MS = 700;
/** A badge that sits on text stays out of the way for this long after each keystroke. */
const TYPING_HIDE_MS = 1200;
const TEXT_RECTS_TTL_MS = 150;
/** Page elements the badge must not be placed over when it sits outside the field. */
const CLICKABLE = 'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [contenteditable=""], [contenteditable="true"]';

interface Anchor {
  host: HTMLElement;
  root: ShadowRoot;
  /** When the anchor had to be put back into its container: a page that removes it over and over is not worth fighting. */
  attached: number[];
}

/**
 * Apps whose DOM is too sensitive to add our anchor element to (every block is a live editor
 * that reacts to foreign changes): there the underlines step aside while an area scrolls instead.
 */
const ANCHORLESS_HOSTS = /(^|\.)notion\.(so|site|com)$/;

/**
 * Inline and !important, because page CSS wins over a shadow root's :host rules. Real cases:
 * sites built from web components (Reddit) hide every custom element that isn't registered yet
 * with ":not(:defined) { visibility: hidden }", and content scripts can't register ours.
 * Also keeps page rules like "container > *" from moving or showing the anchors.
 */
function pinHostStyle(host: HTMLElement, extra: Record<string, string> = {}): void {
  const style: Record<string, string> = {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    margin: '0',
    padding: '0',
    border: '0',
    overflow: 'visible',
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    transform: 'none',
    filter: 'none',
    'clip-path': 'none',
    'z-index': '2147483647',
    ...extra,
  };
  for (const [name, value] of Object.entries(style)) host.style.setProperty(name, value, 'important');
}

interface HitBox {
  session: FieldSession;
  issue: FieldIssue;
  rects: DOMRect[];
}

const TYPE_LABEL: Record<IssueType, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
};

/** Darker than the browser's own red spellcheck squiggle, so our underline reads as Rewordly's. */
const ERROR_COLOR = '#ce2c31';

const CSS = `
:host { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; }
* { box-sizing: border-box; }
.mirrors { position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; visibility: hidden; pointer-events: none; }
.clip { position: absolute; overflow: hidden; pointer-events: none; }
/* Fields inside fixed/sticky boxes (chat popups, modals) stay put while the page scrolls. */
.clip.pinned { position: fixed; }
/* While the field itself scrolls (see Overlay.noteScroll) the underlines step aside at once and fade back in afterwards. */
.clip.scrolling .mark { opacity: 0; transition: none; }
.mark {
  position: absolute; pointer-events: none; border-radius: 2px;
  /* A solid 2px line, deliberately unlike the browser's wavy spellcheck underline. */
  background: linear-gradient(${ERROR_COLOR}, ${ERROR_COLOR}) no-repeat left bottom / 100% 2px;
  /* Drawn in from left to right in place: the clip grows, the line itself never moves or stretches. */
  clip-path: inset(0 100% 0 0);
  transition: clip-path 280ms cubic-bezier(.4,0,.2,1), opacity 160ms ease-out, background-color 120ms ease;
}
.mark.on { clip-path: inset(0 0 0 0); }
.mark.off { clip-path: inset(0 0 0 0); opacity: 0; }
.mark.active { background-color: rgba(206, 44, 49, 0.14); }
.badge {
  all: unset; position: fixed; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #fff;
  background: ${ERROR_COLOR}; box-shadow: 0 1px 3px rgba(0,0,0,.25);
  opacity: 0; transform: scale(.6); transition: opacity 160ms ease, transform 160ms ease, background-color 160ms ease;
}
.badge.on { opacity: 1; transform: none; }
/* Sitting on a line of text: smaller, and hidden while typing (see renderBadge). */
.badge.compact { margin: 3px; width: 16px; height: 16px; font-size: 9px; }
.badge.clean { background: #30a46c; }
.badge.checking, .badge.error { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.badge.limit { background: #8b8d98; }
/* Pause glyph: checking has stopped until the user logs in or upgrades. */
.badge.limit::after { content: ""; width: 3px; height: 8px; border-left: 2px solid #fff; border-right: 2px solid #fff; }
/* Small dot: quota is running low. Hover/click the badge for details. */
.badge.low::before {
  content: ""; position: absolute; top: -2px; right: -2px; width: 7px; height: 7px; border-radius: 50%;
  background: #6e56cf; box-shadow: 0 0 0 2px #fff;
}
.badge.checking::after {
  content: ""; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid #6e56cf; border-right-color: transparent; animation: spin .8s linear infinite;
}
.badge.error::after { content: "!"; color: #8b8d98; }
@keyframes spin { to { transform: rotate(360deg); } }
.card {
  position: fixed; width: 300px; max-width: calc(100vw - 16px); pointer-events: auto;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1c2024; background: #fff; border-radius: 10px;
  box-shadow: 0 10px 38px -10px rgba(22,23,24,.35), 0 10px 20px -15px rgba(22,23,24,.2), 0 0 0 1px rgba(0,0,0,.06);
  opacity: 0; transform: translateY(4px); transition: opacity 140ms ease, transform 140ms ease;
}
.card.on { opacity: 1; transform: none; }
/* Not clickable until it has faded in at its final position. */
.card:not(.on) { pointer-events: none; }
.card[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px 0; color: #60646c; font-size: 12px; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: ${ERROR_COLOR}; }
.close { all: unset; margin-left: auto; cursor: pointer; color: #8b8d98; font-size: 16px; line-height: 1; padding: 2px 4px; }
.body { padding: 8px 12px 10px; }
.fix { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.from { color: #8b8d98; text-decoration: line-through; word-break: break-word; }
.arrow { color: #8b8d98; }
.to {
  all: unset; cursor: pointer; padding: 3px 9px; border-radius: 6px; font-weight: 600;
  color: #fff; background: #6e56cf; word-break: break-word;
}
.to:hover { background: #5b45b8; }
.to.remove { background: ${ERROR_COLOR}; }
.msg { margin-top: 6px; color: #60646c; }
.foot { display: flex; gap: 4px; padding: 6px 8px 8px; border-top: 1px solid #f0f0f3; }
.foot button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px; color: #60646c; font-size: 12px; }
.foot button:hover { background: #f0f0f3; color: #1c2024; }
.foot .all { margin-left: auto; color: #6e56cf; font-weight: 600; }
.note { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid #f0f0f3; color: #60646c; font-size: 12px; }
.note .link { all: unset; cursor: pointer; margin-left: auto; white-space: nowrap; color: #6e56cf; font-weight: 600; }
.fixed { color: #30a46c; font-weight: 600; margin-bottom: 4px; }
.cta { all: unset; cursor: pointer; display: inline-block; margin-top: 8px; padding: 5px 10px; border-radius: 6px; color: #fff; background: #6e56cf; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  .card { color: #edeef0; background: #212225; box-shadow: 0 10px 38px -10px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
  .head, .msg, .foot button { color: #b0b4ba; }
  .foot, .note { border-top-color: #2e3135; }
  .note { color: #b0b4ba; }
  .foot button:hover { background: #2e3135; color: #edeef0; }
  .badge.checking, .badge.error { background: #2e3135; }
}
`;

/** Events from our UI must not reach page "click outside" handlers or steal the field's focus. */
const ISOLATED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];

export class Overlay {
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  readonly mirrors: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly layers = new Map<FieldSession, FieldLayer>();
  private hitBoxes: HitBox[] = [];
  private cardFor: { session: FieldSession; issue: FieldIssue } | null = null;
  private accountCardFor: FieldSession | null = null;
  private account: AccountState = { limit: null, quota: null, fixedToday: 0 };
  private origin = { x: 0, y: 0 };
  /**
   * Opened on purpose (click on a word, the badge): stays until a click elsewhere, Escape or ×.
   * Cards opened by hovering a word close again when the pointer wanders off.
   */
  private cardPinned = false;
  /** Bumped by every badge step, so a slower earlier scroll doesn't open its card afterwards. */
  private revealSeq = 0;
  /** The open card was reached with the badge: after a fix (or ignore) we move on to the next issue. */
  private cardFromBadge = false;
  private readonly pinned = new WeakMap<Element, { value: boolean; at: number }>();
  /** When each badge started showing ✓ (see CLEAN_VISIBLE_MS). */
  private readonly cleanSince = new WeakMap<HTMLElement, number>();
  private scrollAreas = new WeakMap<Element, { scroller: Element | null; container: Element | null; at: number }>();
  private readonly anchors = new Map<Element, Anchor>();
  /** Containers where an added child is not rendered (e.g. a web component showing only named slots). */
  private readonly unrenderable = new WeakSet<Element>();

  constructor(private readonly actions: OverlayActions) {
    this.host = document.createElement('rewordly-live');
    pinHostStyle(this.host);
    // Open in dev builds so e2e tests can inspect the UI.
    this.shadow = this.host.attachShadow({ mode: process.env['NODE_ENV'] === 'production' ? 'closed' : 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.mirrors = document.createElement('div');
    this.mirrors.className = 'mirrors';
    this.card = document.createElement('div');
    this.card.className = 'card';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    this.shadow.append(style, this.mirrors, this.card);

    isolate(this.host);
    this.card.addEventListener('click', (e) => this.onCardClick(e));
    this.attach();
  }

  /** Re-attaches if the page wiped <html>'s children (some SPAs do on navigation). */
  private attach(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  isOwnEvent(event: Event): boolean {
    return event.composedPath().some((node) => this.isOwnHost(node));
  }

  private isOwnHost(node: unknown): boolean {
    if (node === this.host) return true;
    for (const anchor of this.anchors.values()) if (anchor.host === node) return true;
    return false;
  }

  isCardOpen(): boolean {
    return !this.card.hidden;
  }

  /** Draws all sessions. `focused` is the session whose badge is shown. */
  render(sessions: FieldSession[], focused: FieldSession | null, account: AccountState): void {
    this.attach();
    this.account = account;
    // Rewordly's own rewrite/grammar modal (content script) dims the page with a backdrop that
    // hit-testing sees through, so step aside explicitly while it is open.
    const modalOpen = document.documentElement.classList.contains('rewordly-modal-open');
    this.host.style.setProperty('visibility', modalOpen ? 'hidden' : 'visible', 'important');
    if (modalOpen) {
      this.hitBoxes = [];
      this.hideCard();
      return;
    }
    const alive = new Set(sessions);
    for (const [session, layer] of this.layers) {
      if (!alive.has(session)) {
        layer.clip.remove();
        layer.badge.remove();
        this.layers.delete(session);
      }
    }
    this.dropUnusedAnchors();

    this.hitBoxes = [];
    // Viewport position of the document origin (the host is absolutely positioned at 0,0).
    const origin = this.host.getBoundingClientRect();
    this.origin = { x: origin.left, y: origin.top };
    for (const session of sessions) this.renderSession(session, session === focused);

    if (this.cardFor) {
      const box = this.hitBoxes.find((b) => b.session === this.cardFor!.session && b.issue.id === this.cardFor!.issue.id);
      if (box) this.placeCard(box.rects[0]!);
      else this.hideCard();
    } else if (this.accountCardFor) {
      const layer = this.layers.get(this.accountCardFor);
      const anchor = layer ? this.badgeAnchorRect(this.accountCardFor) : null;
      if (anchor) this.placeCard(anchor);
    }
  }

  /**
   * Something scrolled. Returns false when it can't concern anything we draw (a message list
   * next to the composer), so the caller can skip the redraw.
   *
   * The page's scroll, and the scroll of an area we anchored the layer in, carry the underlines
   * along by themselves. The field's own scroll (a long message in Slack's composer) and areas
   * we couldn't anchor in have no such carrier: the browser scrolls on its own thread while we
   * can only redraw a frame later, which shows as underlines wobbling against the text. So the
   * affected underlines step aside right away and come back once the scrolling stops.
   */
  noteScroll(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true;
    let related = false;
    for (const [session, layer] of this.layers) {
      const el = session.el;
      const own = target === el || el.contains(target);
      if (!own && !target.contains(el)) continue;
      related = true;
      if (own || !layer.anchoredIn) {
        layer.scrollingUntil = Date.now() + SCROLL_SETTLE_MS;
        layer.clip.classList.add('scrolling');
      }
    }
    return related;
  }

  private layerFor(session: FieldSession): FieldLayer {
    let layer = this.layers.get(session);
    if (!layer) {
      const clip = document.createElement('div');
      clip.className = 'clip';
      const badge = document.createElement('button');
      badge.className = 'badge';
      badge.type = 'button';
      badge.addEventListener('click', () => this.onBadgeClick(session));
      this.shadow.insertBefore(clip, this.card);
      this.shadow.insertBefore(badge, this.card);
      layer = { clip, marks: new Map(), badge, anchoredIn: null, badgeAnchor: null, badgeFieldSize: '', textRects: null, scrollingUntil: 0 };
      this.layers.set(session, layer);
    }
    return layer;
  }

  private renderSession(session: FieldSession, focused: boolean): void {
    const layer = this.layerFor(session);
    const field = session.el.getBoundingClientRect();
    const visible = field.width > 0 && field.height > 0 && field.bottom > 0 && field.top < innerHeight;

    // Clip to the field's padding box so underlines of scrolled-away text don't leak out,
    // and to the visible part of the window and of the field's scroll area, so the layer
    // never makes the page (or that area) taller or wider.
    const area = this.scrollAreaFor(session.el);
    const box = visibleBox(area.scroller);
    const style = getComputedStyle(session.el);
    const padLeft = field.left + parseFloat(style.borderLeftWidth);
    const padTop = field.top + parseFloat(style.borderTopWidth);
    const clipLeft = Math.max(padLeft, box.left);
    const clipTop = Math.max(padTop, box.top);
    const clipRight = Math.min(padLeft + session.el.clientWidth, box.right);
    const clipBottom = Math.min(padTop + session.el.clientHeight, box.bottom);

    // Where the layer lives decides what carries it while scrolling (see the file comment).
    const anchor = area.container ? this.anchorFor(area.container) : null;
    const root = anchor?.root ?? this.shadow;
    if (layer.clip.parentNode !== root) root.insertBefore(layer.clip, root === this.shadow ? this.card : null);
    layer.anchoredIn = anchor ? area.container : null;
    const pinned = !anchor && this.isPinned(session.el);
    let shift = pinned ? { x: 0, y: 0 } : this.origin;
    if (anchor) {
      const at = anchor.host.getBoundingClientRect();
      shift = { x: at.left, y: at.top };
    }
    layer.clip.classList.toggle('pinned', pinned);
    layer.clip.classList.toggle('scrolling', Date.now() < layer.scrollingUntil);
    Object.assign(layer.clip.style, {
      left: `${clipLeft - shift.x}px`,
      top: `${clipTop - shift.y}px`,
      width: `${Math.max(0, clipRight - clipLeft)}px`,
      height: `${Math.max(0, clipBottom - clipTop)}px`,
      display: visible ? 'block' : 'none',
    });

    const issues = visible ? session.visibleIssues() : [];
    const seen = new Set<string>();
    for (const issue of issues) {
      const rects = session.adapter
        .rectsFor(issue.offset, issue.offset + issue.length)
        .filter((r) => this.isUncovered(session, r.left + r.width / 2, r.top + r.height / 2));
      if (rects.length === 0) continue;
      seen.add(issue.id);
      this.hitBoxes.push({ session, issue, rects });

      let mark = layer.marks.get(issue.id);
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'mark';
        layer.clip.appendChild(mark);
        layer.marks.set(issue.id, mark);
        // Next frame, so the transition from the initial state runs.
        const el = mark;
        requestAnimationFrame(() => el.classList.add('on'));
      }
      // Multi-line issues: one mark spanning the first line is enough to read; extra lines get clones.
      this.positionMark(mark, rects[0]!, clipLeft, clipTop);
      this.syncExtraLines(layer, issue.id, rects.slice(1), clipLeft, clipTop);
      rects.slice(1).forEach((_, i) => seen.add(`${issue.id}#${i + 1}`));
    }
    this.syncActive(session, layer);

    for (const [id, mark] of layer.marks) {
      if (seen.has(id)) continue;
      layer.marks.delete(id);
      mark.classList.replace('on', 'off');
      setTimeout(() => mark.remove(), 180);
    }

    const placement = badgePlacementFor(session.el, location.hostname);
    const picked =
      focused && visible
        ? this.pickBadge(session, layer, badgeFrame(session.el, placement), placement, {
            top: box.top,
            width: innerWidth,
            height: box.bottom,
          })
        : null;
    const spot = picked?.spot ?? null;
    const spotFree = !!spot && this.isUncovered(session, spot.probeX, spot.probeY);
    // Inside a scroll area the badge rides with the content too, unless it follows the area's edge.
    const badgeInAnchor = !!anchor && !!spot && !spot.followsViewport;
    const badgeRoot = badgeInAnchor ? anchor!.root : this.shadow;
    if (layer.badge.parentNode !== badgeRoot) badgeRoot.insertBefore(layer.badge, badgeInAnchor ? null : this.card);
    this.renderBadge(layer.badge, session, focused && visible && spotFree, spot, issues.length, pinned, badgeInAnchor ? shift : null, picked?.overlaps ?? false);
  }

  /** The badge's spot: placements.ts picks it; this supplies what it needs to know about the page. */
  private pickBadge(
    session: FieldSession,
    layer: FieldLayer,
    frame: DOMRect,
    placement: ReturnType<typeof badgePlacementFor>,
    viewport: { width: number; height: number; top: number }
  ): { spot: BadgeSpot; anchor: BadgeAnchor; overlaps: boolean } | null {
    const field = session.el.getBoundingClientRect();
    const size = `${Math.round(field.width)}x${Math.round(field.height)}`;
    if (layer.badgeFieldSize !== size) {
      layer.badgeFieldSize = size;
      layer.badgeAnchor = null;
    }
    const picked = chooseBadgeSpot(
      frame,
      placement,
      {
        viewport,
        textRects: () => this.textRectsOf(session, layer, field),
        isFree: (x, y) => this.isClickFree(session, x, y),
      },
      layer.badgeAnchor ? { prefer: layer.badgeAnchor } : {}
    );
    const anchor = picked?.anchor ?? null;
    if (anchor !== layer.badgeAnchor) {
      debug('badge spot:', anchor ?? 'none free, badge hidden', session.el);
      layer.badgeAnchor = anchor;
    }
    return picked;
  }

  /** The field's text rects, cached relative to the field so a page scroll doesn't make them stale. */
  private textRectsOf(session: FieldSession, layer: FieldLayer, field: DOMRect): DOMRect[] {
    if (!layer.textRects || Date.now() - layer.textRects.at > TEXT_RECTS_TTL_MS) {
      layer.textRects = {
        at: Date.now(),
        rel: session.adapter.textRects().map((r) => [r.left - field.left, r.top - field.top, r.width, r.height]),
      };
    }
    return layer.textRects.rel.map(([x, y, w, h]) => new DOMRect(field.left + x!, field.top + y!, w, h));
  }

  /** False when something clickable of the page is at this point. */
  private isClickFree(session: FieldSession, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const root = session.el.getRootNode() as Document | ShadowRoot;
    // Look through our own overlay: the badge already sitting here would otherwise hide what is under it.
    const top = root.elementsFromPoint(x, y).find((el) => !this.isOwnHost(el));
    return !top || !top.closest(CLICKABLE);
  }

  /** What the account card points at: the badge, or the field itself when the badge isn't shown. */
  private badgeAnchorRect(session: FieldSession): DOMRect | null {
    const badge = this.layers.get(session)?.badge;
    if (!badge) return null;
    return badge.classList.contains('on') ? badge.getBoundingClientRect() : session.el.getBoundingClientRect();
  }

  /**
   * The field's nearest scroll area (other than the page), and the element inside it our anchor
   * goes into: the closest positioned ancestor of the field within that area, so the anchor
   * scrolls with the content. Null container: no such ancestor, we fall back to redrawing.
   */
  private scrollAreaFor(el: Element): { scroller: Element | null; container: Element | null } {
    const cached = this.scrollAreas.get(el);
    if (cached && Date.now() - cached.at < 1000 && (!cached.container || cached.container.isConnected)) return cached;
    const scroller = scrollParentOf(el);
    let container: Element | null = null;
    if (scroller) {
      // Stay in the field's own tree: a child added to a shadow host's light DOM would not render.
      for (let node = el.parentElement; node; node = node.parentElement) {
        // A shadow host displays only what its slots take: Reddit's <shreddit-composer> shows
        // its slot="rte" editor but would never render our anchor.
        const usable = !node.shadowRoot && !this.unrenderable.has(node);
        if (usable && getComputedStyle(node).position !== 'static') {
          container = node;
          break;
        }
        if (node === scroller) break;
      }
      if (container && !scroller.contains(container) && container !== scroller) container = null;
      if (ANCHORLESS_HOSTS.test(location.hostname)) container = null;
    }
    if (scroller && !container && !cached) debug('field is in a scroll area without a positioned box to draw in; redrawing on scroll', scroller);
    const entry = { scroller, container, at: Date.now() };
    this.scrollAreas.set(el, entry);
    return entry;
  }

  private anchorFor(container: Element): Anchor | null {
    let anchor = this.anchors.get(container);
    if (!anchor) {
      const host = document.createElement('rewordly-anchor');
      pinHostStyle(host, { 'pointer-events': 'none' });
      host.setAttribute('aria-hidden', 'true');
      const root = host.attachShadow({ mode: process.env['NODE_ENV'] === 'production' ? 'closed' : 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.append(style);
      isolate(host);
      anchor = { host, root, attached: [] };
      this.anchors.set(container, anchor);
      debug('field is in its own scroll area; drawing inside it', container);
    }
    // Re-added if the page re-rendered the container's children.
    if (anchor.host.parentNode !== container) {
      const now = Date.now();
      anchor.attached = anchor.attached.filter((at) => now - at < 5000).concat(now);
      if (anchor.attached.length > 4) return this.giveUpAnchor(container, anchor, 'the page keeps removing it');
      container.appendChild(anchor.host);
      // Not rendered there (closed shadow root, display:contents, ...): never use this container again.
      if (anchor.host.getClientRects().length === 0) return this.giveUpAnchor(container, anchor, 'it is not rendered there');
    }
    return anchor;
  }

  /** Never use this container again: the underlines step aside while its area scrolls instead. */
  private giveUpAnchor(container: Element, anchor: Anchor, why: string): null {
    debug(`no anchor in this scroll area (${why}); hiding underlines while it scrolls instead`, container);
    anchor.host.remove();
    this.anchors.delete(container);
    this.unrenderable.add(container);
    this.scrollAreas = new WeakMap();
    return null;
  }

  private dropUnusedAnchors(): void {
    const used = new Set<Element | null>();
    for (const layer of this.layers.values()) used.add(layer.anchoredIn);
    for (const [container, anchor] of this.anchors) {
      if (used.has(container) && container.isConnected) continue;
      anchor.host.remove();
      this.anchors.delete(container);
    }
  }

  /** True when the field sits in a fixed or sticky box, which doesn't move with the page scroll. */
  private isPinned(el: Element): boolean {
    const cached = this.pinned.get(el);
    if (cached && Date.now() - cached.at < 1000) return cached.value;
    let value = false;
    for (let node: Element | null = el; node; ) {
      const position = getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') {
        value = true;
        break;
      }
      node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    }
    this.pinned.set(el, { value, at: Date.now() });
    return value;
  }

  /**
   * False when something else is drawn on top of the field at this point (a site's modal,
   * dropdown or sticky header, or our own selection modal). Our overlay sits above every
   * page layer, so without this an underline would show through whatever covers the field.
   */
  private isUncovered(session: FieldSession, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const root = session.el.getRootNode() as Document | ShadowRoot;
    const top = root.elementFromPoint(x, y);
    // Our own badge/card can sit over the field; the overlay host is what hit-testing returns then.
    return !top || this.isOwnHost(top) || top === session.el || session.el.contains(top);
  }

  private positionMark(mark: HTMLDivElement, rect: DOMRect, clipLeft: number, clipTop: number): void {
    mark.style.left = `${rect.left - clipLeft}px`;
    mark.style.top = `${rect.top - clipTop}px`;
    mark.style.width = `${rect.width}px`;
    mark.style.height = `${rect.height + 1}px`;
  }

  private syncExtraLines(layer: FieldLayer, id: string, rects: DOMRect[], clipLeft: number, clipTop: number): void {
    rects.forEach((rect, i) => {
      const key = `${id}#${i + 1}`;
      let mark = layer.marks.get(key);
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'mark';
        // Continue onto the next line once the previous one has been drawn.
        mark.style.transitionDelay = `${(i + 1) * 280}ms, 0ms, 0ms`;
        layer.clip.appendChild(mark);
        layer.marks.set(key, mark);
        const el = mark;
        requestAnimationFrame(() => el.classList.add('on'));
      }
      this.positionMark(mark, rect, clipLeft, clipTop);
    });
  }

  private renderBadge(
    badge: HTMLButtonElement,
    session: FieldSession,
    show: boolean,
    spot: BadgeSpot | null,
    count: number,
    pinned: boolean,
    anchorShift: { x: number; y: number } | null,
    overlaps: boolean
  ): void {
    const limit = this.account.limit;
    const checking = session.status === 'checking';
    // A check in flight is not news: the last result stays (count or ✓) and the spinner only appears
    // for a first check that is slow. Otherwise it would flash on every typing pause.
    const slowFirstCheck = checking && !session.hasResult && Date.now() - session.checkingSince > SPINNER_DELAY_MS;
    // An empty field has nothing to report: no ✓, no spinner (only a reached limit is still worth showing).
    const empty = !session.text.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    const state = limit
      ? 'limit'
      : empty
        ? 'idle'
        : checking
        ? slowFirstCheck ? 'checking' : count > 0 ? 'issues' : session.hasResult ? 'clean' : 'idle'
        : session.status === 'error' ? 'error' : count > 0 ? 'issues' : session.status === 'done' ? 'clean' : 'idle';
    // ✓ is feedback, not a permanent fixture: it fades after a moment. Issues, checking and
    // limit/error stay, since those are what the user may want to act on.
    if (state === 'clean' && show) {
      if (!this.cleanSince.has(badge)) this.cleanSince.set(badge, Date.now());
    } else {
      this.cleanSince.delete(badge);
    }
    const faded = state === 'clean' && Date.now() - (this.cleanSince.get(badge) ?? Date.now()) > CLEAN_VISIBLE_MS;
    // On top of text: out of the way while typing, back a moment after the last keystroke.
    const inTheWay = overlaps && session.typedWithin(TYPING_HIDE_MS);
    const shown = show && state !== 'idle' && !faded && spot !== null && !inTheWay;
    badge.classList.toggle('on', shown);
    badge.classList.toggle('compact', overlaps);
    badge.classList.toggle('checking', state === 'checking');
    badge.classList.toggle('error', state === 'error');
    badge.classList.toggle('clean', state === 'clean');
    badge.classList.toggle('limit', state === 'limit');
    badge.classList.toggle('low', state !== 'limit' && isLow(this.account));
    badge.textContent = state === 'issues' ? (count > 9 ? '9+' : String(count)) : state === 'clean' ? '✓' : '';
    badge.title =
      state === 'issues' ? `Rewordly: ${count} issue${count === 1 ? '' : 's'}` :
      state === 'clean' ? 'Rewordly: no issues found' :
      state === 'checking' ? 'Rewordly: checking…' :
      state === 'limit' ? `Rewordly: ${limitNudge(this.account).text}` : state === 'error' ? 'Rewordly: check failed, retrying' : '';
    badge.style.pointerEvents = shown ? 'auto' : 'none';

    // Where: see placements.ts (per-site rules, bottom-right inside the field by default).
    if (!spot) return;
    // Like the underlines, ride along with the page scroll, unless the spot follows the viewport edge.
    const docCoords = !pinned && !spot.followsViewport;
    const shift = anchorShift ?? (docCoords ? this.origin : { x: 0, y: 0 });
    badge.style.position = anchorShift || docCoords ? 'absolute' : 'fixed';
    badge.style.left = `${spot.left - shift.x}px`;
    badge.style.top = `${spot.top - shift.y}px`;
  }

  /** Issue under the pointer, if any. */
  hitTest(x: number, y: number): HitBox | null {
    for (const box of this.hitBoxes) {
      for (const r of box.rects) {
        if (x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 3) return box;
      }
    }
    return null;
  }

  isCardPinned(): boolean {
    return !this.card.hidden && this.cardPinned;
  }

  isCardFor(box: HitBox): boolean {
    return !this.card.hidden && this.cardFor?.session === box.session && this.cardFor.issue.id === box.issue.id;
  }

  isOverCard(x: number, y: number): boolean {
    if (this.card.hidden) return false;
    const r = this.card.getBoundingClientRect();
    return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 8 && y <= r.bottom + 4;
  }

  showCard(session: FieldSession, issue: FieldIssue, total: number, anchor: DOMRect, pinned = false): void {
    if (this.cardFor?.session === session && this.cardFor.issue.id === issue.id) {
      this.cardPinned ||= pinned;
      return;
    }
    this.cardPinned = pinned;
    this.cardFromBadge = false;
    this.cardFor = { session, issue };
    this.accountCardFor = null;

    const replacement = issue.replacements[0] ?? '';
    this.card.replaceChildren();
    this.card.append(
      this.head(TYPE_LABEL[issue.type] ?? 'Suggestion'),
      el('div', 'body', [
        el('div', 'fix', [
          el('span', 'from', issue.original),
          el('span', 'arrow', '→'),
          ...issue.replacements.slice(0, 3).map((r) =>
            button(r === '' ? 'to remove' : 'to', r === '' ? 'Remove' : r, { act: 'apply', value: r })
          ),
        ]),
        issue.message ? el('div', 'msg', issue.message) : null,
      ]),
      el('div', 'foot', [
        button('', 'Ignore', { act: 'ignore' }),
        issue.type === 'spelling' ? button('', 'Add to dictionary', { act: 'dict' }) : button('', 'Always ignore', { act: 'always' }),
        total > 1 ? button('all', `Fix all (${total})`, { act: 'all' }) : null,
      ]),
      ...[this.note(lowNudge(this.account))].filter((n): n is HTMLElement => n !== null)
    );
    this.card.setAttribute('aria-label', `${TYPE_LABEL[issue.type]}: replace ${issue.original} with ${replacement}`);
    this.openCard(anchor);
    // Right away, not on the next redraw (which may be up to a poll interval away).
    for (const [s, layer] of this.layers) this.syncActive(s, layer);
  }

  /** Highlights the marks of the issue whose card is open (all its lines). */
  private syncActive(session: FieldSession, layer: FieldLayer): void {
    const id = this.cardFor?.session === session ? this.cardFor.issue.id : null;
    for (const [key, mark] of layer.marks) {
      mark.classList.toggle('active', id !== null && (key === id || key.startsWith(`${id}#`)));
    }
  }

  /** Plan status: why checking stopped, or how much is left, with one call to action. */
  private showAccountCard(session: FieldSession, nudge: Nudge, anchor: DOMRect): void {
    this.cardFor = null;
    this.cardPinned = true;
    this.accountCardFor = session;
    const fixed = fixedTodayText(this.account);
    this.card.replaceChildren(
      this.head('Rewordly'),
      el('div', 'body', [
        fixed ? el('div', 'fixed', fixed) : null,
        el('div', 'msg', nudge.text),
        nudge.cta ? button('cta', nudge.cta.label, { act: 'cta', kind: nudge.cta.kind }) : null,
      ])
    );
    this.openCard(anchor);
  }

  private note(nudge: Nudge | null): HTMLElement | null {
    if (!nudge) return null;
    return el('div', 'note', [
      el('span', '', nudge.text),
      nudge.cta ? button('link', nudge.cta.label, { act: 'cta', kind: nudge.cta.kind }) : null,
    ]);
  }

  private head(label: string): HTMLElement {
    return el('div', 'head', [el('span', 'dot'), el('span', '', label), button('close', '×', { act: 'close' })]);
  }

  /** Shows the card already at its final position, so it never flashes (or catches clicks) elsewhere. */
  private openCard(anchor: DOMRect): void {
    const wasHidden = this.card.hidden;
    this.card.hidden = false;
    this.placeCard(anchor);
    if (wasHidden) {
      this.card.classList.remove('on');
      requestAnimationFrame(() => this.card.classList.add('on'));
    }
  }

  private placeCard(anchor: DOMRect): void {
    const card = this.card.getBoundingClientRect();
    const gap = 6;
    let top = anchor.bottom + gap;
    if (top + card.height > innerHeight - 8 && anchor.top - gap - card.height > 8) top = anchor.top - gap - card.height;
    const left = Math.max(8, Math.min(anchor.left, innerWidth - card.width - 8));
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }

  hideCard(): void {
    if (this.card.hidden) return;
    this.cardFor = null;
    this.accountCardFor = null;
    this.cardPinned = false;
    this.cardFromBadge = false;
    this.card.classList.remove('on');
    this.card.hidden = true;
    for (const [s, layer] of this.layers) this.syncActive(s, layer);
  }

  private onBadgeClick(session: FieldSession): void {
    const badge = this.layers.get(session)?.badge;
    if (!badge) return;
    this.actions.badgeClicked();
    if (this.account.limit) {
      this.showAccountCard(session, limitNudge(this.account), badge.getBoundingClientRect());
      return;
    }
    const issues = session.visibleIssues().sort((a, b) => a.offset - b.offset);
    if (issues.length === 0) {
      const low = lowNudge(this.account);
      if (low) this.showAccountCard(session, low, badge.getBoundingClientRect());
      return;
    }
    // With a card open, the badge steps to the next issue; otherwise it opens the first one on
    // screen, or the first in the field when none is (scrolling it into view).
    const current = this.cardFor?.session === session ? this.cardFor.issue : null;
    const onScreen = this.hitBoxes.filter((b) => b.session === session && this.inViewport(b.rects[0]!));
    const next = current
      ? issues.find((i) => i.offset > current.offset) ?? issues[0]!
      : issues.find((i) => onScreen.some((b) => b.issue.id === i.id)) ?? issues[0]!;
    void this.reveal(session, next, issues.length);
  }

  private inViewport(r: DOMRect): boolean {
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }

  /** Scrolls an issue into view if needed, then opens its card. */
  private async reveal(session: FieldSession, issue: FieldIssue, total: number): Promise<void> {
    const end = issue.offset + issue.length;
    // Drawn and not covered means on screen, inside the field's own scroll area too.
    const box = this.hitBoxes.find((b) => b.session === session && b.issue.id === issue.id);
    let rect = box?.rects[0];
    const seq = ++this.revealSeq;
    if (!rect || !this.inViewport(rect)) {
      this.hideCard();
      await session.adapter.reveal(issue.offset, end);
      if (seq !== this.revealSeq) return;
      rect = session.adapter.rectsFor(issue.offset, end)[0];
    }
    if (rect) {
      this.showCard(session, issue, total, rect, true);
      this.cardFromBadge = true;
    }
  }

  /** Like pressing the badge again: the next issue after the one just handled, scrolled to if needed. */
  private async stepAfter(session: FieldSession, handled: FieldIssue): Promise<void> {
    // Let the edit land and a render update what is on screen.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!this.layers.has(session) || !this.card.hidden) return;
    const issues = session.visibleIssues().sort((a, b) => a.offset - b.offset);
    if (issues.length === 0) return;
    const next = issues.find((i) => i.offset >= handled.offset && i.id !== handled.id) ?? issues[0]!;
    await this.reveal(session, next, issues.length);
  }

  /** Opens the limit card next to a session's badge (the controller does this at most once a day). */
  announceLimit(session: FieldSession): void {
    const anchor = this.badgeAnchorRect(session);
    if (anchor) this.showAccountCard(session, limitNudge(this.account), anchor);
  }

  private onCardClick(event: Event): void {
    const target = (event.target as Element).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const act = target.dataset['act'];
    const current = this.cardFor;
    if (act === 'close') return this.hideCard();
    if (act === 'cta') {
      this.hideCard();
      return this.actions.openAccountAction(target.dataset['kind'] === 'login' ? 'login' : 'upgrade');
    }
    if (!current) return;
    const stepOn = this.cardFromBadge && act !== 'all';
    this.hideCard();
    let done: Promise<void> | void = undefined;
    if (act === 'apply') done = this.actions.apply(current.session, current.issue, target.dataset['value'] ?? '');
    else if (act === 'ignore') this.actions.ignore(current.session, current.issue);
    else if (act === 'dict') done = this.actions.addToDictionary(current.session, current.issue);
    else if (act === 'always') this.actions.ignoreAlways(current.session, current.issue);
    else if (act === 'all') this.actions.applyAll(current.session);
    if (stepOn) void Promise.resolve(done).then(() => this.stepAfter(current.session, current.issue));
  }

  destroy(): void {
    this.host.remove();
    for (const anchor of this.anchors.values()) anchor.host.remove();
    this.anchors.clear();
    this.layers.clear();
  }
}

/** Events from our UI must not reach the page, nor take focus or the selection from the field. */
function isolate(host: HTMLElement): void {
  for (const type of ISOLATED_EVENTS) {
    host.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'mousedown' || type === 'pointerdown') e.preventDefault();
    });
  }
}

/** The nearest ancestor (in the field's own tree) that scrolls vertically, the page itself excluded. */
function scrollParentOf(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.scrollingElement || node === document.body || node === document.documentElement) return null;
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The part of the window that `scroller` (or the page, when null) shows. */
function visibleBox(scroller: Element | null): { left: number; top: number; right: number; bottom: number } {
  const box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  if (!scroller) return box;
  const r = scroller.getBoundingClientRect();
  return {
    left: Math.max(box.left, r.left + scroller.clientLeft),
    top: Math.max(box.top, r.top + scroller.clientTop),
    right: Math.min(box.right, r.left + scroller.clientLeft + scroller.clientWidth),
    bottom: Math.min(box.bottom, r.top + scroller.clientTop + scroller.clientHeight),
  };
}

function el(tag: string, className: string, content?: string | Array<Node | null>): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else if (content) node.append(...content.filter((c): c is Node => c !== null));
  return node;
}

function button(className: string, label: string, data: Record<string, string>): HTMLButtonElement {
  const b = el('button', className, label) as HTMLButtonElement;
  b.type = 'button';
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}
