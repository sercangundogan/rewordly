/**
 * While we check a field, the browser's own spellcheck squiggles would only duplicate (and
 * clash with) our underlines, so it is switched off on that field and restored afterwards:
 * when the field is dropped, live checking is turned off, or the quota runs out.
 *
 * The original attribute value is kept in MARK, which also tells targets.ts that a
 * spellcheck="false" is ours and not the site opting the field out.
 *
 * Some pages undo the change every time (Notion rewrites a block's attributes whenever it
 * changes). Answering that over and over is a fight that never ends and can freeze the tab,
 * so after a few reverts we give up on that element and leave the page's value alone.
 */

export const MARK = 'data-rewordly-spellcheck';

const MAX_REVERTS = 3;
const REVERT_WINDOW_MS = 5000;
/** Elements we turned spellcheck off on at least once: if it is on again, the page did it. */
const applied = new WeakSet<Element>();
const reverts = new WeakMap<Element, { count: number; since: number }>();
const gaveUp = new WeakSet<Element>();

/** The field, plus elements inside it that turn spellcheck back on for themselves. */
function targets(el: HTMLElement): Element[] {
  return [el, ...el.querySelectorAll('[spellcheck]:not([spellcheck="false"])')];
}

function suppress(el: Element, gaveUpNow: Element[]): void {
  if (gaveUp.has(el)) return;
  const on = el.getAttribute('spellcheck') !== 'false';
  if (on && applied.has(el)) {
    const now = Date.now();
    const seen = reverts.get(el);
    const record = !seen || now - seen.since > REVERT_WINDOW_MS ? { count: 0, since: now } : seen;
    record.count++;
    reverts.set(el, record);
    if (record.count > MAX_REVERTS) {
      gaveUp.add(el);
      el.removeAttribute(MARK);
      gaveUpNow.push(el);
      return;
    }
  }
  if (!el.hasAttribute(MARK)) el.setAttribute(MARK, el.getAttribute('spellcheck') ?? '');
  if (on) el.setAttribute('spellcheck', 'false');
  applied.add(el);
}

function restore(el: Element): void {
  if (!el.hasAttribute(MARK)) return;
  const original = el.getAttribute(MARK)!;
  el.removeAttribute(MARK);
  if (original === '') el.removeAttribute('spellcheck');
  else el.setAttribute('spellcheck', original);
}

/**
 * Some editors set spellcheck again whenever they re-render a block (Notion writes
 * spellcheck="true" on its block elements); calling this again simply re-applies it.
 * Returns the elements we just gave up on (the page keeps undoing it).
 */
export function suppressNativeSpellcheck(el: HTMLElement): Element[] {
  const gaveUpNow: Element[] = [];
  targets(el).forEach((target) => suppress(target, gaveUpNow));
  return gaveUpNow;
}

export function restoreNativeSpellcheck(el: HTMLElement): void {
  restore(el);
  el.querySelectorAll(`[${MARK}]`).forEach(restore);
}
