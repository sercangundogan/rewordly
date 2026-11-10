/**
 * Where the status badge (issue count / ✓) sits for a field.
 *
 * The default, bottom-right inside the field, suits bordered boxes (comments, composers).
 * The badge stays where it is: a badge that jumps to another part of the screen while
 * someone types is worse than one that sits on a line end for a moment. chooseBadgeSpot
 * only reports whether the text is under it (`overlaps`), so the caller can shrink it and
 * keep it out of the way while typing. Moving to another spot (outside the field, top-right,
 * below the field) is available with `fallbacks: true` but is not used by the overlay.
 *
 * Site rules below are hints on top of that, for editors where the first choice should
 * be another spot from the start. Adding a site is one entry in BADGE_RULES; deleting
 * the entry brings back the default.
 */

export type BadgeAnchor =
  /** Bottom-right corner inside the field (default). */
  | 'inside-bottom-right'
  /** Top-right corner inside the field. */
  | 'inside-top-right'
  /** Just right of the field, level with the bottom of its visible part. Falls back to inside when there is no room. */
  | 'outside-right'
  /** Right-aligned just below the field. */
  | 'below-right'
  /** No badge at all for this field. */
  | 'hidden';

export interface BadgePlacement {
  anchor: BadgeAnchor;
  /** Extra shift in px, applied after the anchor. */
  dx?: number;
  dy?: number;
  /**
   * Selector of an element inside the field whose box is used instead of the field's,
   * e.g. the text column of a full-width editor. Falls back to the field itself.
   */
  measure?: string;
}

export interface BadgeRule {
  /** Short name, shown in dev logs. */
  id: string;
  /** Hostnames the rule applies to (subdomains included). Omit for every site. */
  hosts?: string[];
  /** Matched against the field element (the outermost contenteditable, textarea or input). */
  selector: string;
  badge: BadgePlacement;
}

export const BADGE_RULES: BadgeRule[] = [
  {
    // Story editor (new story / edit): a borderless full-page editor, so the corner spot sits on the text.
    id: 'medium-story',
    hosts: ['medium.com'],
    selector: '.postArticle-content',
    badge: { anchor: 'outside-right', measure: '.section-inner' },
  },
  {
    // Private note on a highlight (side panel): the editor has no padding, so the corner spot
    // sits on the last line. Recognised by the quoted paragraph shown above the note.
    id: 'medium-private-note',
    hosts: ['medium.com'],
    selector: ':has(> * > p[data-selectable-paragraph]) [data-slate-editor]',
    badge: { anchor: 'inside-bottom-right', dy: 6 },
  },
];

export const DEFAULT_BADGE: BadgePlacement = { anchor: 'inside-bottom-right' };

export const BADGE_SIZE = 22;
const BELOW_GAP = 4;
/** Room kept around the badge when checking that no text is under it. */
const TEXT_MARGIN = 4;
/** Tried in this order after the preferred spot. */
const FALLBACKS: BadgeAnchor[] = ['inside-bottom-right', 'outside-right', 'inside-top-right', 'below-right'];
/** Distance from the field's edges (inside) or from its right edge (outside). */
const INSET = 6;
const GAP = 12;
/** Keep the badge this far above the bottom of the viewport. */
const VIEWPORT_MARGIN = 16;

function hostMatches(hostname: string, hosts: string[] | undefined): boolean {
  return !hosts || hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/** The first rule matching the field wins. */
export function badgeRuleFor(el: Element, hostname: string, rules: BadgeRule[] = BADGE_RULES): BadgeRule | null {
  return rules.find((r) => hostMatches(hostname, r.hosts) && el.matches(r.selector)) ?? null;
}

export function badgePlacementFor(el: Element, hostname: string, rules: BadgeRule[] = BADGE_RULES): BadgePlacement {
  return badgeRuleFor(el, hostname, rules)?.badge ?? DEFAULT_BADGE;
}

/** The box a placement is measured against. */
export function badgeFrame(el: Element, placement: BadgePlacement): DOMRect {
  const inner = placement.measure ? el.querySelector(placement.measure) : null;
  const field = el.getBoundingClientRect();
  if (!inner) return field;
  // The inner column decides left/right; the field still decides how far down the text goes.
  const col = inner.getBoundingClientRect();
  return new DOMRect(col.left, field.top, col.width, field.height);
}

export interface BadgeSpot {
  left: number;
  top: number;
  /** A point inside the field next to the badge, used to tell whether the field is covered there. */
  probeX: number;
  probeY: number;
  /** True when the spot is pinned to the viewport edge (tall field), so it must not scroll with the page. */
  followsViewport: boolean;
}

/** Top-left of the badge in viewport px, or null when the placement hides it. */
export function badgeSpot(
  frame: DOMRect,
  placement: BadgePlacement,
  viewport: { width: number; height: number; top?: number }
): BadgeSpot | null {
  if (placement.anchor === 'hidden') return null;
  // Tall editors: stay level with the bottom of the visible part, never below the viewport
  // (or below the scroll area the field is in: then `top`/`height` describe that area).
  const visibleBottom = Math.min(frame.bottom, viewport.height - VIEWPORT_MARGIN);
  const visibleTop = Math.max(frame.top, viewport.top ?? 0);

  let anchor = placement.anchor;
  if (anchor === 'outside-right' && frame.right + GAP + BADGE_SIZE > viewport.width - INSET) anchor = 'inside-bottom-right';

  let left: number;
  let top: number;
  if (anchor === 'outside-right') {
    left = frame.right + GAP;
    top = visibleBottom - BADGE_SIZE;
  } else if (anchor === 'below-right') {
    left = frame.right - BADGE_SIZE;
    top = frame.bottom + BELOW_GAP;
  } else {
    left = frame.right - INSET - BADGE_SIZE;
    top = anchor === 'inside-top-right' ? visibleTop + INSET : visibleBottom - INSET - BADGE_SIZE;
  }
  // Short fields: never above the field's top.
  if (anchor !== 'below-right') top = Math.max(top, visibleTop);
  const followsViewport = anchor !== 'below-right' && (frame.bottom > visibleBottom || frame.top < visibleTop);
  left = Math.round(left + (placement.dx ?? 0));
  top = Math.round(top + (placement.dy ?? 0));

  const centerY = Math.min(Math.max(top + BADGE_SIZE / 2, visibleTop + 1), visibleBottom - 1);
  const probeX = anchor === 'outside-right' ? frame.right - 2 : left + BADGE_SIZE / 2;
  return { left, top, probeX, probeY: centerY, followsViewport };
}

type Viewport = { width: number; height: number; top?: number };

/** False when there is no room for the anchor on screen (checked before computing its spot). */
export function fitsAnchor(frame: DOMRect, anchor: BadgeAnchor, viewport: Viewport): boolean {
  if (anchor === 'outside-right') return frame.right + GAP + BADGE_SIZE <= viewport.width - INSET;
  if (anchor === 'below-right') {
    return frame.bottom >= (viewport.top ?? 0) && frame.bottom + BELOW_GAP + BADGE_SIZE <= viewport.height - INSET;
  }
  return true;
}

export interface PlacementContext {
  viewport: Viewport;
  /** Rects of the field's text in viewport px; only read when a spot inside the field is tried. */
  textRects(): DOMRect[];
  /** False when something clickable of the page is at this point (used for spots outside the field). */
  isFree(x: number, y: number): boolean;
}

function isClear(spot: BadgeSpot, anchor: BadgeAnchor, ctx: PlacementContext): boolean {
  if (anchor === 'outside-right' || anchor === 'below-right') {
    return ctx.isFree(spot.left + BADGE_SIZE / 2, spot.top + BADGE_SIZE / 2);
  }
  const left = spot.left - TEXT_MARGIN;
  const top = spot.top - TEXT_MARGIN;
  const right = spot.left + BADGE_SIZE + TEXT_MARGIN;
  const bottom = spot.top + BADGE_SIZE + TEXT_MARGIN;
  return !ctx.textRects().some((r) => r.left < right && left < r.right && r.top < bottom && top < r.bottom);
}

/**
 * The first free spot: the rule's own anchor (default: bottom-right inside), then the
 * fallbacks. `prefer` (the spot used last time) goes first so the badge stays where it
 * is for as long as it is still free. Null when the placement hides the badge or no spot is free.
 */
export function chooseBadgeSpot(
  frame: DOMRect,
  placement: BadgePlacement,
  ctx: PlacementContext,
  options: { fallbacks?: boolean; prefer?: BadgeAnchor } = {}
): { spot: BadgeSpot; anchor: BadgeAnchor; overlaps: boolean } | null {
  if (placement.anchor === 'hidden') return null;
  const { fallbacks = false, prefer } = options;
  const order: BadgePlacement[] = [
    placement,
    ...(fallbacks ? FALLBACKS.filter((a) => a !== placement.anchor).map((anchor): BadgePlacement => ({ anchor })) : []),
  ];
  const preferred = order.findIndex((c) => c.anchor === prefer);
  if (preferred > 0) order.unshift(...order.splice(preferred, 1));

  let first: { spot: BadgeSpot; anchor: BadgeAnchor } | null = null;
  for (const candidate of order) {
    if (!fitsAnchor(frame, candidate.anchor, ctx.viewport)) continue;
    const spot = badgeSpot(frame, candidate, ctx.viewport);
    if (!spot) continue;
    first ??= { spot, anchor: candidate.anchor };
    if (isClear(spot, candidate.anchor, ctx)) return { spot, anchor: candidate.anchor, overlaps: false };
  }
  // Nothing is free (or fallbacks are off): the first spot, flagged as covering something.
  if (first) return { ...first, overlaps: true };
  // The rule's anchor doesn't fit on screen (e.g. outside-right at the window edge): its inside variant.
  const inside = badgeSpot(frame, { anchor: 'inside-bottom-right' }, ctx.viewport);
  return inside ? { spot: inside, anchor: 'inside-bottom-right', overlaps: !isClear(inside, 'inside-bottom-right', ctx) } : null;
}
