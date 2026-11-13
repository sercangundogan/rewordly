/**
 * Pure text helpers for the live checker: paragraph splitting, hashing, and
 * shifting issue offsets across edits. No DOM access, so they are unit tested.
 */

export type IssueType = 'spelling' | 'grammar' | 'punctuation';

/** Issue relative to a text unit, as returned by POST /api/check. */
export interface ParagraphIssue {
  offset: number;
  length: number;
  original: string;
  replacements: string[];
  message: string;
  type: IssueType;
  /** Opaque id of the suggestion from the server; reported back when the user ignores it. */
  fp?: string;
}

const ISSUE_TYPES = new Set<string>(['spelling', 'grammar', 'punctuation']);
const MAX_ISSUES_PER_SENTENCE = 100;
const MAX_REPLACEMENTS = 5;
const MAX_REPLACEMENT_CHARS = 500;
const MAX_MESSAGE_CHARS = 300;

/**
 * What a reply says about one sentence, checked against the sentence itself before anything is drawn
 * or applied: whole numbers in range, the quoted word really there, a few plain-text replacements.
 * A broken, outdated or tampered-with reply then costs a few missing underlines, never an exception
 * in the page or a replacement that lands in the wrong place.
 */
export function sanitizeIssues(text: string, raw: unknown): ParagraphIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: ParagraphIssue[] = [];
  for (const item of raw.slice(0, MAX_ISSUES_PER_SENTENCE)) {
    if (!item || typeof item !== 'object') continue;
    const { offset, length, original, replacements, message, type, fp } = item as Record<string, unknown>;
    if (!Number.isInteger(offset) || !Number.isInteger(length)) continue;
    const start = offset as number;
    const size = length as number;
    if (start < 0 || size <= 0 || start + size > text.length) continue;
    if (typeof original !== 'string' || text.slice(start, start + size) !== original) continue;
    if (!Array.isArray(replacements)) continue;
    const options = replacements
      .filter((r): r is string => typeof r === 'string' && r.length <= MAX_REPLACEMENT_CHARS)
      .slice(0, MAX_REPLACEMENTS);
    if (options.length === 0) continue;
    issues.push({
      offset: start,
      length: size,
      original,
      replacements: options,
      message: typeof message === 'string' ? message.slice(0, MAX_MESSAGE_CHARS) : '',
      type: typeof type === 'string' && ISSUE_TYPES.has(type) ? (type as IssueType) : 'grammar',
      ...(typeof fp === 'string' && /^[0-9a-f]{8,64}$/.test(fp) ? { fp } : {}),
    });
  }
  return issues;
}

/** Issue relative to the whole field text. */
export interface FieldIssue extends ParagraphIssue {
  /** Stable across edits elsewhere in the field: unit hash + offset in that unit. */
  id: string;
}

/**
 * A checkable piece of field text: one sentence (long sentences are chunked).
 * Sentences, not paragraphs, so editing one word re-checks only its sentence.
 */
export interface TextUnit {
  /** Offset of the unit in the field text. */
  start: number;
  text: string;
  hash: string;
}

/** Units longer than this are cut at a space (server max is 3000). */
export const MAX_UNIT_CHARS = 1500;

/** FNV-1a (32-bit) + length; collisions only cost a wrong cache hit on identical-length text. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}${text.length.toString(36)}`;
}

/** True when the text has something worth checking (letters, not just a word or two of noise). */
function isCheckable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 3 && /\p{L}{2}/u.test(trimmed);
}

/** True when a sentence looks finished (ends with terminal punctuation, maybe followed by quotes/brackets). */
export function isTerminated(text: string): boolean {
  return /[.!?…。！？][\s"'”’)\]]*$/u.test(text);
}

/** Pause after a keystroke before checking, while the user is in the middle of something. */
export const TYPING_DEBOUNCE_MS = 800;
/** A sentence that was clearly just finished ("... done. ", "really?") is checked almost at once. */
export const SENTENCE_END_MS = 150;
/** A bare "." may still become "3.5", "e.g." or "...": wait a little longer, so those are not sent half-typed. */
export const PERIOD_MS = 400;

const CLOSERS = '["\'”’)\\]]*';
const ENDED_THEN_SPACE = new RegExp(`[.!?…。！？]${CLOSERS}\\s+$`, 'u');
const ENDED_FOR_SURE = new RegExp(`[!?…。！？]${CLOSERS}$`, 'u');
const ENDED_WITH_PERIOD = new RegExp(`\\.${CLOSERS}$`, 'u');

/**
 * How long to wait before checking, from the text right before the caret after a keystroke.
 * Waiting the full pause after every sentence made each one feel slow: the user had finished it,
 * and the check only started 0.8 s later.
 */
export function delayAfterTyping(beforeCaret: string): number {
  if (ENDED_THEN_SPACE.test(beforeCaret) || ENDED_FOR_SURE.test(beforeCaret)) return SENTENCE_END_MS;
  if (ENDED_WITH_PERIOD.test(beforeCaret)) return PERIOD_MS;
  return TYPING_DEBOUNCE_MS;
}

const sentenceSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

/** [start, end) ranges of the sentences in a line, without surrounding whitespace. */
function sentenceRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const segments = sentenceSegmenter ? Array.from(sentenceSegmenter.segment(line)) : [{ segment: line, index: 0 }];
  for (const { segment, index } of segments) {
    const lead = segment.length - segment.trimStart().length;
    const end = index + segment.trimEnd().length;
    if (end > index + lead) ranges.push([index + lead, end]);
  }
  return ranges;
}

/** Splits field text into checkable sentence units, line by line. */
export function splitUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  const push = (start: number, chunk: string) => {
    if (isCheckable(chunk)) units.push({ start, text: chunk, hash: hashText(chunk) });
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;

    for (const [from, to] of sentenceRanges(text.slice(lineStart, lineEnd))) {
      let chunkStart = lineStart + from;
      const chunkEnd = lineStart + to;
      while (chunkEnd - chunkStart > MAX_UNIT_CHARS) {
        const window = text.slice(chunkStart, chunkStart + MAX_UNIT_CHARS);
        const cut = window.lastIndexOf(' ') + 1 || MAX_UNIT_CHARS;
        push(chunkStart, text.slice(chunkStart, chunkStart + cut).trimEnd());
        chunkStart += cut;
      }
      push(chunkStart, text.slice(chunkStart, chunkEnd));
    }
    lineStart = lineEnd + 1;
  }

  return units;
}

export interface TextDiff {
  /** First changed index (same in old and new text). */
  start: number;
  /** End of the changed region in the old text. */
  oldEnd: number;
  /** End of the changed region in the new text. */
  newEnd: number;
}

/** Smallest single changed region between two strings (common prefix/suffix). */
export function diffText(prev: string, next: string): TextDiff | null {
  if (prev === next) return null;
  let start = 0;
  const minLength = Math.min(prev.length, next.length);
  while (start < minLength && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let suffix = 0;
  while (
    suffix < minLength - start &&
    prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { start, oldEnd: prev.length - suffix, newEnd: next.length - suffix };
}

/**
 * Moves issues to follow an edit. Issues touching the edited region are dropped
 * (they are stale until the next check); issues after it shift by the length delta.
 * Anything that no longer matches the text it pointed at is dropped too.
 */
export function shiftIssues(issues: FieldIssue[], diff: TextDiff, nextText: string): FieldIssue[] {
  const delta = diff.newEnd - diff.oldEnd;
  const shifted: FieldIssue[] = [];
  for (const issue of issues) {
    const end = issue.offset + issue.length;
    let offset: number;
    if (end <= diff.start) offset = issue.offset;
    else if (issue.offset >= diff.oldEnd) offset = issue.offset + delta;
    else continue;
    if (nextText.slice(offset, offset + issue.length) !== issue.original) continue;
    // Typing directly against the word ("dont" → "donts") changes it even though the old span still matches.
    if (glued(nextText, offset - 1, issue.original[0]) || glued(nextText, offset + issue.length, issue.original[issue.length - 1])) {
      continue;
    }
    shifted.push({ ...issue, offset });
  }
  return shifted;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when the character at `index` would join a word with the issue's edge character. */
function glued(text: string, index: number, edge: string | undefined): boolean {
  if (index < 0 || index >= text.length || !edge) return false;
  return WORD_CHAR.test(edge) && WORD_CHAR.test(text[index]!);
}

/** Maps unit-relative issues to field offsets. */
export function toFieldIssues(unit: TextUnit, issues: ParagraphIssue[]): FieldIssue[] {
  return issues
    .filter((i) => unit.text.slice(i.offset, i.offset + i.length) === i.original)
    .map((i) => ({
      ...i,
      id: `${unit.hash}:${i.offset}:${i.original}`,
      offset: unit.start + i.offset,
    }));
}

// --- text that is never prose ----------------------------------------------

const TLDS = 'com|net|org|io|co|dev|app|ai|me|tv|gg|ly|so|xyz|info|biz|edu|gov|tr|de|uk|fr|es|it|nl|ru|jp|cn|in|br|us|ca|au|eu';
/**
 * Links (with or without a scheme), email addresses, @mentions and #hashtags. Trailing sentence
 * punctuation is not part of a link ("see x.com/a." ends at "a").
 */
const PROTECTED = new RegExp(
  [
    '\\b(?:https?://|www\\.)[^\\s<>"]+',
    '[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+',
    `\\b(?:[\\p{L}\\p{N}-]+\\.)+(?:${TLDS})\\b(?:/[^\\s<>"]*)?`,
    '(?<![\\p{L}\\p{N}_])[@#][\\p{L}\\p{N}_]+',
  ].join('|'),
  'giu'
);
const TRAILING_PUNCTUATION = /[.,!?;:)\]}'"…]+$/;

/** [start, end) ranges of `text` the checker must never underline. */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(PROTECTED)) {
    const token = match[0].replace(TRAILING_PUNCTUATION, '');
    if (token) ranges.push([match.index!, match.index! + token.length]);
  }
  return ranges;
}

/**
 * The model is told not to flag links, emails, mentions or hashtags, but it sometimes "fixes"
 * one anyway (x.com/…/statusss). Drop such issues deterministically.
 */
export function touchesProtected(issue: { offset: number; length: number }, ranges: Array<[number, number]>): boolean {
  const end = issue.offset + issue.length;
  return ranges.some(([from, to]) => issue.offset < to && from < end);
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();

/**
 * True when a suggestion only adds words that are already right next to it: "yanlışın" →
 * "yanlışın var" when the text already reads "yanlışın var". Applying it would just repeat
 * them ("var var"), so it is not a real issue. The model makes this mistake now and then.
 */
export function repeatsNeighbour(text: string, offset: number, length: number, replacement: string): boolean {
  const original = text.slice(offset, offset + length);
  let added: string[];
  let neighbours: string[];
  if (original && replacement.startsWith(original)) {
    added = words(replacement.slice(original.length));
    neighbours = words(text.slice(offset + length)).slice(0, added.length);
  } else if (original && replacement.endsWith(original)) {
    added = words(replacement.slice(0, replacement.length - original.length));
    neighbours = words(text.slice(0, offset)).slice(-added.length);
  } else {
    return false;
  }
  if (added.length === 0 || neighbours.length !== added.length) return false;
  return added.every((word, i) => bare(word) !== '' && bare(word) === bare(neighbours[i]!));
}
