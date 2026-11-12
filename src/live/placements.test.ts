// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  BADGE_SIZE,
  badgePlacementFor,
  badgeRuleFor,
  badgeSpot,
  chooseBadgeSpot,
  DEFAULT_BADGE,
  fitsAnchor,
  type BadgeRule,
  type PlacementContext,
} from './placements';

const VIEWPORT = { width: 1280, height: 800 };

function el(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('badge rules', () => {
  const medium = '<div class="postArticle-content js-postField editable" role="textbox" contenteditable="true"></div>';

  it("matches Medium's story editor on medium.com and its subdomains", () => {
    expect(badgeRuleFor(el(medium), 'medium.com')?.id).toBe('medium-story');
    expect(badgeRuleFor(el(medium), 'someone.medium.com')?.id).toBe('medium-story');
  });

  it("matches Medium's private note editor (the one under a quoted highlight), not other Slate editors", () => {
    const note = el(
      '<div><div><p data-selectable-paragraph><mark>quoted</mark></p></div><div><div><div id="f" data-slate-editor="true" contenteditable="true"></div></div></div></div>'
    );
    expect(badgeRuleFor(note.querySelector('#f')!, 'medium.com')?.id).toBe('medium-private-note');
    const response = el('<div><div><div id="f" data-slate-editor="true" contenteditable="true"></div></div></div>');
    expect(badgeRuleFor(response.querySelector('#f')!, 'medium.com')).toBeNull();
  });

  it('ignores the same markup on other sites', () => {
    expect(badgeRuleFor(el(medium), 'notmedium.com')).toBeNull();
    expect(badgePlacementFor(el(medium), 'example.com')).toBe(DEFAULT_BADGE);
  });

  it('first matching rule wins; rules without hosts apply everywhere', () => {
    const rules: BadgeRule[] = [
      { id: 'a', selector: '.x', badge: { anchor: 'hidden' } },
      { id: 'b', selector: '.x', badge: { anchor: 'inside-top-right' } },
    ];
    expect(badgeRuleFor(el('<textarea class="x"></textarea>'), 'any.site', rules)?.id).toBe('a');
  });
});

describe('badgeSpot', () => {
  it('default: bottom-right inside the field', () => {
    const spot = badgeSpot(new DOMRect(100, 100, 400, 100), DEFAULT_BADGE, VIEWPORT)!;
    expect(spot.left + BADGE_SIZE).toBeLessThanOrEqual(500);
    expect(spot.top + BADGE_SIZE).toBeLessThanOrEqual(200);
    expect(spot.top).toBeGreaterThan(150);
  });

  it('outside-right: in the margin, level with the bottom of the visible part of a tall editor', () => {
    const spot = badgeSpot(new DOMRect(300, 50, 680, 3000), { anchor: 'outside-right' }, VIEWPORT)!;
    expect(spot.left).toBeGreaterThan(980);
    expect(spot.top + BADGE_SIZE).toBeLessThanOrEqual(VIEWPORT.height - 10);
    // Coverage is probed inside the field, not in the margin.
    expect(spot.probeX).toBeLessThan(980);
  });

  it('outside-right falls back to inside when the field touches the window edge', () => {
    const spot = badgeSpot(new DOMRect(0, 0, 1280, 400), { anchor: 'outside-right' }, VIEWPORT)!;
    expect(spot.left + BADGE_SIZE).toBeLessThanOrEqual(1280);
  });

  it('inside-top-right, offsets and hidden', () => {
    const spot = badgeSpot(new DOMRect(100, 100, 400, 300), { anchor: 'inside-top-right', dx: -10, dy: 4 }, VIEWPORT)!;
    expect(spot.top).toBe(110);
    expect(spot.left).toBe(500 - 6 - BADGE_SIZE - 10);
    expect(badgeSpot(new DOMRect(100, 100, 400, 300), { anchor: 'hidden' }, VIEWPORT)).toBeNull();
  });

  it('never above a short field', () => {
    const spot = badgeSpot(new DOMRect(100, 100, 400, 20), DEFAULT_BADGE, VIEWPORT)!;
    expect(spot.top).toBeGreaterThanOrEqual(100);
  });
});

describe('chooseBadgeSpot', () => {
  const frame = new DOMRect(100, 100, 400, 100);
  const ctx = (textRects: DOMRect[] = [], isFree = () => true): PlacementContext => ({
    viewport: VIEWPORT,
    textRects: () => textRects,
    isFree,
  });
  // The text of a full line, reaching the right edge of the field.
  const fullLine = new DOMRect(110, 170, 380, 18);
  const moving = { fallbacks: true } as const;

  it('takes the default spot when no text is under it', () => {
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx([new DOMRect(110, 110, 120, 18)]))!;
    expect(picked.anchor).toBe('inside-bottom-right');
    expect(picked.overlaps).toBe(false);
  });

  it('stays in the corner when text is under it, and says so', () => {
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx([fullLine]))!;
    expect(picked.anchor).toBe('inside-bottom-right');
    expect(picked.overlaps).toBe(true);
    expect(picked.spot.left + BADGE_SIZE).toBeLessThanOrEqual(500);
  });

  it('with fallbacks, moves outside the field when text is under the default spot', () => {
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx([fullLine]), moving)!;
    expect(picked.anchor).toBe('outside-right');
    expect(picked.spot.left).toBeGreaterThanOrEqual(500);
    expect(picked.overlaps).toBe(false);
  });

  it('with fallbacks, keeps the spot it had while that spot is free', () => {
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx([]), { ...moving, prefer: 'outside-right' })!;
    expect(picked.anchor).toBe('outside-right');
  });

  it('with fallbacks, leaves a remembered spot once it is blocked', () => {
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx([fullLine], (): boolean => false), { ...moving, prefer: 'outside-right' })!;
    expect(picked.anchor).toBe('inside-top-right');
  });

  it('skips spots that do not fit on screen', () => {
    const wide = new DOMRect(0, 100, 1270, 100);
    expect(fitsAnchor(wide, 'outside-right', VIEWPORT)).toBe(false);
    const low = new DOMRect(100, 700, 400, 90);
    expect(fitsAnchor(low, 'below-right', VIEWPORT)).toBe(false);
    const picked = chooseBadgeSpot(wide, DEFAULT_BADGE, ctx([new DOMRect(10, 170, 1250, 18)]), moving)!;
    expect(picked.anchor).toBe('inside-top-right');
  });

  it('is not shown only when the rule hides it', () => {
    expect(chooseBadgeSpot(frame, { anchor: 'hidden' }, ctx())).toBeNull();
    const everywhere = [fullLine, new DOMRect(110, 106, 380, 18)];
    const picked = chooseBadgeSpot(frame, DEFAULT_BADGE, ctx(everywhere, (): boolean => false), moving)!;
    expect(picked.overlaps).toBe(true);
  });

  it("a rule's own anchor comes first", () => {
    const picked = chooseBadgeSpot(frame, { anchor: 'inside-top-right', dy: 4 }, ctx())!;
    expect(picked.anchor).toBe('inside-top-right');
    expect(picked.spot.top).toBe(100 + 6 + 4);
  });

  it("a rule's anchor that does not fit on screen falls back to the corner inside", () => {
    const wide = new DOMRect(0, 100, 1270, 100);
    const picked = chooseBadgeSpot(wide, { anchor: 'outside-right' }, ctx())!;
    expect(picked.anchor).toBe('inside-bottom-right');
  });

  it('below-right sits under the field, right-aligned', () => {
    const picked = chooseBadgeSpot(frame, { anchor: 'below-right' }, ctx())!;
    expect(picked.spot.top).toBe(204);
    expect(picked.spot.left + BADGE_SIZE).toBe(500);
  });
});
