import { describe, expect, it } from 'vitest';
import { diffText, hashText, isTerminated, protectedRanges, repeatsNeighbour, sanitizeIssues, shiftIssues, splitUnits, toFieldIssues, touchesProtected, MAX_UNIT_CHARS, type FieldIssue,
  delayAfterTyping,
  PERIOD_MS,
  SENTENCE_END_MS,
  TYPING_DEBOUNCE_MS,
} from './text';

function issue(text: string, original: string, from = 0): FieldIssue {
  const offset = text.indexOf(original, from);
  return { id: `x:${offset}`, offset, length: original.length, original, replacements: ['fix'], message: '', type: 'spelling' };
}

describe('splitUnits', () => {
  it('splits into sentences per line and keeps absolute offsets', () => {
    const text = 'First sentence here. Second one?\n\nThird line here!';
    const units = splitUnits(text);
    expect(units.map((u) => u.text)).toEqual(['First sentence here.', 'Second one?', 'Third line here!']);
    for (const u of units) expect(text.slice(u.start, u.start + u.text.length)).toBe(u.text);
  });

  it('editing one sentence leaves the other sentences hashes unchanged', () => {
    const before = splitUnits('Keep this one. Change this one.');
    const after = splitUnits('Keep this one. Changed this one.');
    expect(after[0]!.hash).toBe(before[0]!.hash);
    expect(after[1]!.hash).not.toBe(before[1]!.hash);
  });

  it('skips noise without letters', () => {
    expect(splitUnits('123\n:)\nok fine')).toHaveLength(1);
  });

  it('cuts very long sentences within the limit', () => {
    const text = 'word '.repeat(700).trim();
    const units = splitUnits(text);
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) {
      expect(u.text.length).toBeLessThanOrEqual(MAX_UNIT_CHARS);
      expect(text.slice(u.start, u.start + u.text.length)).toBe(u.text);
    }
  });

  it('gives identical sentences identical hashes', () => {
    const [a, b] = splitUnits('same text\nsame text');
    expect(a!.hash).toBe(b!.hash);
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('isTerminated', () => {
  it('recognises finished sentences', () => {
    expect(isTerminated('Done.')).toBe(true);
    expect(isTerminated('Really?" ')).toBe(true);
    expect(isTerminated('Bitti mi…')).toBe(true);
    expect(isTerminated('still typing')).toBe(false);
  });
});

describe('diffText', () => {
  it('finds the single changed region', () => {
    expect(diffText('hello world', 'hello brave world')).toEqual({ start: 6, oldEnd: 6, newEnd: 12 });
    expect(diffText('abc', 'abc')).toBeNull();
  });
});

describe('shiftIssues', () => {
  it('keeps issues before the edit and shifts issues after it', () => {
    const prev = 'I has a cat. She dont care.';
    const next = 'Hey, I has a cat. She dont care.';
    const shifted = shiftIssues([issue(prev, 'has'), issue(prev, 'dont')], diffText(prev, next)!, next);
    expect(shifted.map((i) => next.slice(i.offset, i.offset + i.length))).toEqual(['has', 'dont']);
  });

  it('drops issues inside or glued to the edit', () => {
    const prev = 'She dont care.';
    expect(shiftIssues([issue(prev, 'dont')], diffText(prev, 'She donts care.')!, 'She donts care.')).toEqual([]);
    expect(shiftIssues([issue(prev, 'dont')], diffText(prev, 'She don care.')!, 'She don care.')).toEqual([]);
  });

  it('keeps an issue when a space is typed right after it', () => {
    const prev = 'She dont';
    const next = 'She dont ';
    expect(shiftIssues([issue(prev, 'dont')], diffText(prev, next)!, next)).toHaveLength(1);
  });
});

describe('toFieldIssues', () => {
  it('maps unit offsets to field offsets and drops mismatches', () => {
    const [, p] = splitUnits('Fine.\nShe dont care.');
    const mapped = toFieldIssues(p!, [
      { offset: 4, length: 4, original: 'dont', replacements: ["doesn't"], message: '', type: 'grammar' },
      { offset: 0, length: 3, original: 'xyz', replacements: ['a'], message: '', type: 'grammar' },
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.offset).toBe(10);
  });
});

describe('protectedRanges: links, emails, mentions and hashtags are never underlined', () => {
  const covered = (text: string, word: string) => {
    const at = text.indexOf(word);
    return touchesProtected({ offset: at, length: word.length }, protectedRanges(text));
  };

  it.each([
    ['https://x.com/eliftabiki1/statusss/2115060385711530223', 'statusss'],
    ['Merhaba, şunu gördünüzmü? https://x.com/a/statusss/1', 'statusss'],
    ['See x.com/eliftabiki1/statusss/2 now.', 'eliftabiki1'],
    ['Visit www.exmaple.com today', 'exmaple'],
    ['Mail me at jhon.doe@gmial.com please', 'gmial'],
    ['Thanks @jhondoe for this', 'jhondoe'],
    ['Loving #remotwork lately', 'remotwork'],
    ['Built with Node.js and next.dev', 'next'],
  ])('%s → "%s" is protected', (text, word) => {
    expect(covered(text, word)).toBe(true);
  });

  it.each([
    ['Merhaba, şunu gördünüzmü? https://x.com/a', 'gördünüzmü'],
    ['I dont know. See https://x.com/a.', 'dont'],
    ['The meeting is at 5.30 tomorow', 'tomorow'],
    ['He said "teh" twice', 'teh'],
    ['Email isnt working', 'isnt'],
  ])('%s → "%s" is still checked', (text, word) => {
    expect(covered(text, word)).toBe(false);
  });

  it('ends a link before sentence punctuation', () => {
    const text = 'Look at https://x.com/a. Then reply';
    expect(protectedRanges(text)).toEqual([[8, 23]]);
  });
});

describe('repeatsNeighbour: suggestions that only repeat the next (or previous) words', () => {
  const check = (text: string, original: string, replacement: string) =>
    repeatsNeighbour(text, text.indexOf(original), original.length, replacement);

  it('"yanlışın" → "yanlışın var" when "var" already follows', () => {
    expect(check('Bence yanlışın var kanka.', 'yanlışın', 'yanlışın var')).toBe(true);
    expect(check('Bence yanlışın var.', 'yanlışın', 'yanlışın var')).toBe(true);
  });

  it('adding a word that is already before it', () => {
    expect(check('I am going home', 'going', 'am going')).toBe(true);
  });

  it('real insertions are kept', () => {
    expect(check('Bence yanlışın kanka.', 'yanlışın', 'yanlışın var')).toBe(false);
    expect(check('I going home', 'going', 'am going')).toBe(false);
    expect(check('She various things', 'She', 'She var')).toBe(false);
    expect(check('I dont know', 'dont', "don't")).toBe(false);
  });
});

describe('sanitizeIssues: a reply is checked against the sentence it is about', () => {
  const text = 'I dont know teh answer.';
  const good = { offset: 2, length: 4, original: 'dont', replacements: ["don't"], message: 'Contraction', type: 'grammar' };

  it('keeps a valid issue as it is', () => {
    expect(sanitizeIssues(text, [good])).toEqual([good]);
  });

  it('keeps a fingerprint only when it looks like one', () => {
    expect(sanitizeIssues(text, [{ ...good, fp: 'a'.repeat(40) }])[0]!.fp).toBe('a'.repeat(40));
    expect(sanitizeIssues(text, [{ ...good, fp: '<img onerror=x>' }])[0]).not.toHaveProperty('fp');
    expect(sanitizeIssues(text, [{ ...good, fp: 5 }])[0]).not.toHaveProperty('fp');
  });

  it.each([
    ['not an array', 'nope'],
    ['null', null],
    ['an object instead of a list', { 0: {} }],
  ])('a reply that is %s gives no issues', (_label, raw) => {
    expect(sanitizeIssues(text, raw)).toEqual([]);
  });

  it.each([
    ['negative offset', { ...good, offset: -3 }],
    ['offset past the end', { ...good, offset: 1_000_000_000 }],
    ['fractional offset', { ...good, offset: 2.5 }],
    ['NaN-like offset', { ...good, offset: 'NaN' }],
    ['offset as a string', { ...good, offset: '2' }],
    ['zero length', { ...good, length: 0 }],
    ['negative length', { ...good, length: -4 }],
    ['range running past the end', { ...good, length: 500 }],
    ['quoted word that is not there', { ...good, original: 'doont' }],
    ['original missing', { offset: 2, length: 4, replacements: ['x'] }],
    ['replacements missing', { offset: 2, length: 4, original: 'dont' }],
    ['replacements not a list', { ...good, replacements: "don't" }],
    ['only non-text replacements', { ...good, replacements: [1, null, {}] }],
    ['only absurdly long replacements', { ...good, replacements: ['x'.repeat(501)] }],
    ['an entry that is not an object', 7],
    ['null entry', null],
  ])('drops an issue with %s', (_label, raw) => {
    expect(sanitizeIssues(text, [raw])).toEqual([]);
  });

  it('one bad issue does not take the good ones with it', () => {
    expect(sanitizeIssues(text, [null, { ...good, offset: -1 }, good])).toEqual([good]);
  });

  it('limits what a page can be made to render', () => {
    const many = Array.from({ length: 5000 }, () => good);
    expect(sanitizeIssues(text, many)).toHaveLength(100);
    const [issue] = sanitizeIssues(text, [{ ...good, replacements: Array.from({ length: 50 }, (_, i) => `r${i}`), message: 'm'.repeat(5000) }]);
    expect(issue!.replacements).toHaveLength(5);
    expect(issue!.message).toHaveLength(300);
  });

  it('an unknown type falls back to grammar, a missing message to empty', () => {
    const [issue] = sanitizeIssues(text, [{ ...good, type: 'exploit', message: undefined }]);
    expect(issue).toMatchObject({ type: 'grammar', message: '' });
  });

  it('markup in text fields is kept as plain text: it is only ever rendered as text', () => {
    const html = '<img src=x onerror="window.__pwned=1">';
    const [issue] = sanitizeIssues(text, [{ ...good, message: html, replacements: [html] }]);
    expect(issue).toMatchObject({ message: html, replacements: [html] });
  });

  it('works with emoji and combining characters (offsets are UTF-16 units, like the server)', () => {
    const t = 'Hi 😀 teh 👨‍👩‍👧 end.';
    const at = t.indexOf('teh');
    expect(sanitizeIssues(t, [{ offset: at, length: 3, original: 'teh', replacements: ['the'], message: '', type: 'spelling' }])).toHaveLength(1);
    expect(sanitizeIssues(t, [{ offset: at - 1, length: 3, original: 'teh', replacements: ['the'], message: '', type: 'spelling' }])).toHaveLength(0);
  });
});

describe('delayAfterTyping: how soon a check starts after a keystroke', () => {
  it('a sentence that was clearly finished is checked almost at once', () => {
    for (const text of ['Thanks for the update. ', 'Really?', 'Stop!', 'He said "no." ', 'Tamam mı?', 'Bitti.\n', 'そうです。']) {
      expect(delayAfterTyping(text), text).toBe(SENTENCE_END_MS);
    }
  });

  it('a bare period waits a little: it may still become 3.5, e.g. or ...', () => {
    for (const text of ['It costs 3.', 'Use a tool, e.', 'Well..', 'Done.', 'He said "no."']) {
      expect(delayAfterTyping(text), text).toBe(PERIOD_MS);
    }
  });

  it('anything else waits for the usual typing pause', () => {
    for (const text of ['', 'I dont', 'It costs 3.5', 'Hello, ', 'Thanks for the update. W', 'one\ntwo']) {
      expect(delayAfterTyping(text), text).toBe(TYPING_DEBOUNCE_MS);
    }
  });
});
