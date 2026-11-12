import { describe, expect, it } from 'vitest';
import { isDisabledHere, type PageIdentity } from './disabled';

const page = (over: Partial<PageIdentity> = {}): PageIdentity => ({
  href: 'https://app.example.com/docs/1?x=2#top',
  origin: 'https://app.example.com',
  ancestorOrigins: [],
  ...over,
});

describe('isDisabledHere', () => {
  it('is off when nothing is disabled', () => {
    expect(isDisabledHere(undefined, page())).toBe(false);
    expect(isDisabledHere([], page())).toBe(false);
  });

  it('matches the origin or the exact URL', () => {
    expect(isDisabledHere(['https://app.example.com'], page())).toBe(true);
    expect(isDisabledHere(['https://app.example.com/docs/1?x=2#top'], page())).toBe(true);
  });

  it('does not match another site, another path or a lookalike', () => {
    expect(isDisabledHere(['https://other.example.com'], page())).toBe(false);
    expect(isDisabledHere(['https://app.example.com/docs/2'], page())).toBe(false);
    expect(isDisabledHere(['https://app.example.com.evil.test'], page())).toBe(false);
    expect(isDisabledHere(['example.com'], page())).toBe(false);
  });

  it('an editor framed from another origin follows the page that frames it', () => {
    const frame = page({ href: 'https://editor.vendor.net/frame', origin: 'https://editor.vendor.net', ancestorOrigins: ['https://app.example.com'] });
    expect(isDisabledHere(['https://app.example.com'], frame)).toBe(true);
    expect(isDisabledHere(['https://unrelated.example'], frame)).toBe(false);
  });

  it('a frame with an opaque origin (about:blank, sandboxed) is matched through its parents', () => {
    const blank = page({ href: 'about:blank', origin: 'null', ancestorOrigins: ['https://app.example.com'] });
    expect(isDisabledHere(['https://app.example.com'], blank)).toBe(true);
    expect(isDisabledHere(['null'], blank)).toBe(false);
  });
});
