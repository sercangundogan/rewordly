/**
 * Field adapters: read the text of a field, map text offsets to screen rects,
 * and replace a text range in a way the page's editor (React, Lexical, Draft,
 * ProseMirror, Quill, Slate...) understands and that keeps native undo.
 *
 * The page DOM is never mutated by us except through the browser's own editing
 * commands, exactly as if the user had typed the replacement.
 */

import { isTextField, type LiveTarget, type TextField } from './targets';

/** Upper bound for scanning a big document's text for the badge spot. */
const MAX_TEXT_NODES = 1500;

export interface FieldAdapter {
  readonly el: LiveTarget;
  /** Plain text the offsets refer to. Same length mapping as the DOM (1 char = 1 char). */
  readText(): string;
  /** Viewport rects covering [start, end); empty when the range is not rendered. */
  rectsFor(start: number, end: number): DOMRect[];
  /** Viewport rects of all the text the field shows (not only the checked part), e.g. to keep the badge off it. */
  textRects(): DOMRect[];
  /** Caret offset in the text, or null when the selection is elsewhere. */
  caret(): number | null;
  /** Scrolls [start, end) into view (the field's own scroll and the page's). */
  reveal(start: number, end: number): Promise<void>;
  /** Replaces [start, end) with `text`; resolves true when the field now contains it. */
  replace(start: number, end: number, text: string): Promise<boolean>;
  dispose(): void;
}

export function createAdapter(el: LiveTarget, layer: HTMLElement): FieldAdapter {
  return isTextField(el) ? new TextFieldAdapter(el, layer) : new ContentEditableAdapter(el);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Waits a few frames for an editor to re-render (React-based editors update the DOM asynchronously). */
async function settled(check: () => boolean, frames = 3): Promise<boolean> {
  for (let i = 0; i < frames; i++) {
    await nextFrame();
    if (check()) return true;
  }
  return false;
}

/** Resolves after the next selectionchange (or a short timeout) and one more frame, so editors have synced. */
function selectionSettled(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const doc = el.ownerDocument;
    const done = () => {
      clearTimeout(timer);
      doc.removeEventListener('selectionchange', done);
      requestAnimationFrame(() => resolve());
    };
    const timer = setTimeout(done, 150);
    doc.addEventListener('selectionchange', done);
  });
}

/**
 * Dispatches the beforeinput event a native spellcheck replacement would produce.
 * Returns true when the page's editor handled it (cancelled it to apply the edit itself).
 */
function dispatchBeforeInput(range: Range, text: string): boolean {
  const target = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!target) return false;
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', text);
  const event = new InputEvent('beforeinput', {
    inputType: text ? 'insertReplacementText' : 'deleteContentBackward',
    data: text || null,
    dataTransfer: text ? dataTransfer : null,
    targetRanges: [new StaticRange(range)],
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  return !target.dispatchEvent(event);
}

/** execCommand is deprecated but remains the only way to edit that keeps undo and notifies every editor. */
function execInsert(text: string): boolean {
  try {
    return text ? document.execCommand('insertText', false, text) : document.execCommand('delete', false);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// textarea / input
// ---------------------------------------------------------------------------

/** Computed style properties that affect where text lays out inside a field. */
const MIRRORED_PROPERTIES = [
  'direction',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'fontFeatureSettings',
  'fontKerning',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textAlign',
  'textTransform',
  'textIndent',
  'textRendering',
  'tabSize',
  'wordBreak',
  'overflowWrap',
] as const;

/**
 * Text inputs have no text nodes, so positions come from an invisible "mirror"
 * div laid out with the same box and font, kept in our own overlay layer.
 */
class TextFieldAdapter implements FieldAdapter {
  private readonly mirror: HTMLDivElement;
  private readonly mirrorText: Text;
  private readonly isInput: boolean;

  constructor(readonly el: TextField, layer: HTMLElement) {
    this.isInput = el instanceof HTMLInputElement;
    this.mirror = document.createElement('div');
    this.mirror.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    this.mirrorText = document.createTextNode('');
    span.appendChild(this.mirrorText);
    this.mirror.appendChild(span);
    layer.appendChild(this.mirror);
  }

  readText(): string {
    return this.el.value;
  }

  caret(): number | null {
    const { selectionStart, selectionEnd } = this.el;
    if (selectionStart === null || selectionStart !== selectionEnd) return null;
    return this.el.matches(':focus') ? selectionStart : null;
  }

  private syncMirror(): DOMRect {
    const el = this.el;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const m = this.mirror.style;

    for (const prop of MIRRORED_PROPERTIES) m[prop] = style[prop];
    m.position = 'fixed';
    m.visibility = 'hidden';
    m.pointerEvents = 'none';
    m.margin = '0';
    m.overflow = 'hidden';
    m.borderColor = 'transparent';
    m.boxSizing = 'content-box';
    m.left = `${rect.left}px`;
    m.top = `${rect.top}px`;

    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // clientWidth excludes the scrollbar, which also narrows the wrapping width of a textarea.
    m.width = `${Math.max(0, el.clientWidth - padX)}px`;
    m.height = `${Math.max(0, el.clientHeight - padY)}px`;

    if (this.isInput) {
      // Inputs never wrap and centre their single line vertically.
      m.whiteSpace = 'pre';
      m.display = 'flex';
      m.alignItems = 'center';
    } else {
      m.whiteSpace = 'pre-wrap';
      m.display = 'block';
    }

    const text = el.value;
    // A trailing newline needs a character after it to occupy a line, as in the textarea.
    const mirrored = text.endsWith('\n') ? `${text} ` : text;
    if (this.mirrorText.data !== mirrored) this.mirrorText.data = mirrored;
    return rect;
  }

  rectsFor(start: number, end: number): DOMRect[] {
    if (!this.el.isConnected) return [];
    this.syncMirror();
    const range = document.createRange();
    const length = this.mirrorText.length;
    range.setStart(this.mirrorText, Math.min(start, length));
    range.setEnd(this.mirrorText, Math.min(end, length));
    const dx = this.el.scrollLeft;
    const dy = this.el.scrollTop;
    return Array.from(range.getClientRects())
      .filter((r) => r.width > 0)
      .map((r) => new DOMRect(r.left - dx, r.top - dy, r.width, r.height));
  }

  async reveal(start: number, end: number): Promise<void> {
    const el = this.el;
    const read = () => this.rectsFor(start, end)[0];
    const rect = read();
    if (rect) {
      // rectsFor already subtracts the current scroll; add it back to get the content position.
      const field = el.getBoundingClientRect();
      const y = rect.top + el.scrollTop - field.top;
      const x = rect.left + el.scrollLeft - field.left;
      const outY = y < el.scrollTop || y + rect.height > el.scrollTop + el.clientHeight;
      const outX = x < el.scrollLeft || x + rect.width > el.scrollLeft + el.clientWidth;
      if (outY || outX) {
        el.scrollTo({
          top: outY ? Math.max(0, y - el.clientHeight / 2) : el.scrollTop,
          left: outX ? Math.max(0, x - el.clientWidth / 2) : el.scrollLeft,
          behavior: scrollBehavior(),
        });
        await untilStill(read);
      }
    }
    await revealRect(el, read);
  }

  textRects(): DOMRect[] {
    if (!this.el.isConnected || !this.el.value) return [];
    this.syncMirror();
    const range = document.createRange();
    range.selectNodeContents(this.mirrorText);
    const dx = this.el.scrollLeft;
    const dy = this.el.scrollTop;
    return Array.from(range.getClientRects())
      .filter((r) => r.width > 0)
      .map((r) => new DOMRect(r.left - dx, r.top - dy, r.width, r.height));
  }

  async replace(start: number, end: number, text: string): Promise<boolean> {
    const el = this.el;
    const expected = el.value.slice(0, start) + text + el.value.slice(end);
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    if (execInsert(text) && el.value === expected) return true;

    // Fallback for pages that block execCommand: set the value through the native
    // setter (so React's value tracker sees a change) and announce it.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, expected);
    el.setSelectionRange(start + text.length, start + text.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await nextFrame();
    return el.value === expected;
  }

  dispose(): void {
    this.mirror.remove();
  }
}

/** Smooth, so the user can follow where the next issue is; instant for reduced-motion users. */
function scrollBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Resolves once `read()` stops moving (a smooth scroll has finished), or after ~2 s. */
export async function untilStill(read: () => DOMRect | undefined): Promise<DOMRect | undefined> {
  let last = read();
  let still = 0;
  let moved = false;
  // A smooth scroll may start a frame or two late: don't call it finished before it has moved.
  for (let i = 0; i < 120 && !(still >= 3 && (moved || i >= 10)); i++) {
    await nextFrame();
    const now = read();
    const same = !!now && !!last && now.top === last.top && now.left === last.left;
    if (!same) moved = true;
    still = same ? still + 1 : 0;
    last = now;
  }
  return last;
}

/** The nearest ancestor (across shadow roots) that scrolls vertically, the page itself excluded. */
function scrollParent(el: Element): Element | null {
  const page = document.scrollingElement;
  for (let node = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null); node; ) {
    if (node === page || node === document.body || node === document.documentElement) return null;
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

/**
 * Smoothly scrolls the rect into view: first any scroll containers around `el` (inner to
 * outer), then the page. Each step waits for the previous one to finish, since a smooth
 * scroll moves the rect the next step measures.
 */
async function revealRect(el: Element, rect: () => DOMRect | undefined): Promise<void> {
  const behavior = scrollBehavior();
  for (let box = scrollParent(el); box; box = scrollParent(box)) {
    const r = rect();
    if (!r) return;
    const b = box.getBoundingClientRect();
    if (r.top >= b.top && r.bottom <= b.bottom) continue;
    box.scrollBy({ top: r.top - b.top - box.clientHeight / 3, behavior });
    await untilStill(rect);
  }
  const r = rect();
  if (r && (r.top < 0 || r.bottom > innerHeight)) {
    window.scrollBy({ top: r.top - innerHeight / 3, behavior });
    await untilStill(rect);
  }
}

// ---------------------------------------------------------------------------
// contenteditable
// ---------------------------------------------------------------------------

/** A run of field text that maps 1:1 onto a DOM text node. */
interface Segment {
  node: Text;
  start: number;
  end: number;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
]);

/** Elements whose content is not the user's prose. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'CODE', 'svg']);

/** Quoted replies and signatures (Gmail, Outlook) are not what the user is writing. */
const SKIPPED_SELECTOR =
  '.gmail_quote, .gmail_signature, blockquote[type="cite"], #divRplyFwdMsg, [data-rewordly-ignore], ' +
  // Code blocks that are plain divs rather than <pre>/<code> (Slack's .ql-code-block, most editors' "code-block").
  '[class*="code-block" i], [class*="codeblock" i], [data-language]';

/** Stand-in for atomic inline widgets (mentions, emoji images, chips); never part of an issue. */
const OBJECT_CHAR = '￼';

class ContentEditableAdapter implements FieldAdapter {
  private segments: Segment[] = [];
  private text = '';

  constructor(readonly el: HTMLElement) {}

  readText(): string {
    const segments: Segment[] = [];
    let text = '';

    const breakLine = () => {
      if (text && !text.endsWith('\n')) text += '\n';
    };

    const walk = (node: Node, preformatted: boolean): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = (node as Text).data;
        if (!data) return;
        // Same length as the DOM data so offsets map 1:1; collapse what the browser renders as spaces.
        const normalized = preformatted ? data.replace(/ /g, ' ') : data.replace(/[\n\r\t ]/g, ' ');
        segments.push({ node: node as Text, start: text.length, end: text.length + data.length });
        text += normalized;
        return;
      }
      if (!(node instanceof Element)) return;
      if (SKIPPED_TAGS.has(node.tagName) || node.matches(SKIPPED_SELECTOR)) return;
      if (node.getAttribute('aria-hidden') === 'true') return;

      if (node.tagName === 'BR') {
        text += '\n';
        return;
      }
      if (node.tagName === 'IMG' || node.getAttribute('contenteditable') === 'false') {
        text += OBJECT_CHAR;
        return;
      }

      const block = BLOCK_TAGS.has(node.tagName);
      if (block) breakLine();
      const pre = preformatted || (node instanceof HTMLElement && /^pre/.test(node.style.whiteSpace));
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child, pre);
      if (block) breakLine();
    };

    for (let child = this.el.firstChild; child; child = child.nextSibling) walk(child, false);

    this.segments = segments;
    this.text = text;
    return text;
  }

  /** DOM position for a text offset. `preferEnd` picks the end of a node at a boundary. */
  private position(offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
    const segments = this.segments;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid]!;
      // A start offset lives in [s.start, s.end); an end offset in (s.start, s.end].
      if (preferEnd ? offset <= s.start : offset < s.start) hi = mid - 1;
      else if (preferEnd ? offset > s.end : offset >= s.end) lo = mid + 1;
      else return { node: s.node, offset: offset - s.start };
    }
    return null;
  }

  private rangeFor(start: number, end: number): Range | null {
    const from = this.position(start, false);
    const to = this.position(end, true);
    if (!from || !to || !from.node.isConnected || !to.node.isConnected) return null;
    // Never let an issue span an atomic widget or a line break we inserted.
    if (/[\n￼]/.test(this.text.slice(start, end))) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }

  rectsFor(start: number, end: number): DOMRect[] {
    const range = this.rangeFor(start, end);
    if (!range) return [];
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  }

  textRects(): DOMRect[] {
    // Every text node, including the parts we don't check (code, quotes): the badge must stay off those too.
    const walker = this.el.ownerDocument.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
    const range = this.el.ownerDocument.createRange();
    const rects: DOMRect[] = [];
    let node = walker.nextNode();
    for (let i = 0; node && i < MAX_TEXT_NODES; i++, node = walker.nextNode()) {
      if (!node.nodeValue?.trim()) continue;
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    return rects;
  }

  async reveal(start: number, end: number): Promise<void> {
    const range = this.rangeFor(start, end);
    if (!range) return;
    const block = range.startContainer.parentElement ?? this.el;
    await revealRect(block, () => range.getClientRects()[0]);
  }

  private selection(): Selection | null {
    // Chrome exposes selections inside shadow roots only through the (non-standard) ShadowRoot.getSelection.
    const root = this.el.getRootNode();
    const shadowSelection = root instanceof ShadowRoot
      ? (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
      : null;
    return shadowSelection ?? window.getSelection();
  }

  caret(): number | null {
    const sel = this.selection();
    if (!sel || !sel.isCollapsed || !sel.focusNode || !this.el.contains(sel.focusNode)) return null;
    if (sel.focusNode.nodeType !== Node.TEXT_NODE) return null;
    const segment = this.segments.find((s) => s.node === sel.focusNode);
    return segment ? segment.start + sel.focusOffset : null;
  }

  async replace(start: number, end: number, text: string): Promise<boolean> {
    const original = this.readText();

    // Deletions become a replacement that keeps a neighbouring character ("s asd" → "s"). Editors
    // treat a delete beforeinput as Backspace at their own caret and ignore its target range
    // (Slate deleted one character at the end), while replacements honour the range everywhere.
    if (!text) {
      const prev = original[start - 1];
      const next = original[end];
      if (prev && !/[\n￼]/.test(prev)) return this.replace(start - 1, end, prev);
      if (next && !/[\n￼]/.test(next)) return this.replace(start, end + 1, next);
    }

    if (!this.rangeFor(start, end)) return false;
    const before = original.slice(0, start);
    const after = original.slice(end);
    const done = () => {
      const now = this.readText();
      return now.startsWith(before + text) && now.endsWith(after);
    };
    const untouched = () => this.readText() === original;

    this.el.focus({ preventScroll: true });
    const sel = this.selection();
    if (!sel) return false;
    const select = (): Range | null => {
      const range = this.rangeFor(start, end);
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return range;
    };

    // Each strategy runs only if the previous one left the text untouched, so a fix is never applied twice.
    // 1. beforeinput: editors with their own model (Slate, Lexical, Quill 2) apply edits from this event,
    //    and Chrome does not fire it for execCommand, so they would otherwise keep the old text in the model
    //    and restore it on the next keystroke. A synthetic event has no default action: if the editor
    //    doesn't take it (doesn't cancel it), nothing happens.
    const range = select();
    if (!range) return false;
    // Editors that track the selection in their own model (Draft.js on X) learn about it only from
    // the async selectionchange event. Inserting before that lands the text at their stale caret.
    await selectionSettled(this.el);
    if (dispatchBeforeInput(range, text)) {
      if (await settled(done)) return true;
      if (!untouched()) return false;
    }

    // 2. execCommand: plain contenteditable and editors that read DOM mutations (ProseMirror, Draft.js).
    if (!select()) return false;
    execInsert(text);
    if (await settled(done)) return true;
    if (!untouched()) return false;

    // 3. Plain-text paste, for editors that ignore both.
    const retry = select();
    if (!retry) return false;
    const data = new DataTransfer();
    data.setData('text/plain', text);
    retry.startContainer.parentElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true })
    );
    return settled(done);
  }

  dispose(): void {
    this.segments = [];
  }
}
