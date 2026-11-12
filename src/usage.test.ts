import { describe, expect, it } from 'vitest';
import { siteOf } from './usage';

describe('siteOf', () => {
  it.each([
    ['https://medium.com/new-story', 'medium.com'],
    ['https://www.linkedin.com/feed/', 'linkedin.com'],
    ['https://mail.google.com/mail/u/0/#inbox', 'mail.google.com'],
    ['http://localhost:3000/try', 'private'],
    ['https://192.168.1.5/admin', 'private'],
    ['https://jira.acme.internal/browse/X-1', 'private'],
    ['https://intranet/home', 'private'],
  ])('%s → %s', (url, site) => {
    expect(siteOf(url)).toBe(site);
  });

  it('ignores pages that are not websites', () => {
    expect(siteOf('chrome://extensions')).toBeNull();
    expect(siteOf('file:///Users/me/a.html')).toBeNull();
    expect(siteOf(undefined)).toBeNull();
  });
});
