import { describe, expect, it } from 'vitest';
import { messageSite, NO_SITE, siteOf } from './usage';

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

describe('messageSite: the site a usage event is recorded under', () => {
  it('a content script is always recorded under its own tab, whatever it claims', () => {
    expect(messageSite('https://mail.google.com/mail/u/0/', true, 'evil.com')).toBe('mail.google.com');
  });

  it('the popup (no tab) is recorded under the site it names', () => {
    expect(messageSite('chrome-extension://abc/popup.html', false, 'linkedin.com')).toBe('linkedin.com');
    expect(messageSite('chrome-extension://abc/popup.html', false, NO_SITE)).toBe('none');
    expect(messageSite('chrome-extension://abc/popup.html', false, 'private')).toBe('private');
  });

  it('drops a named site that siteOf would never produce (full URLs, paths, www., intranet names)', () => {
    for (const claimed of ['https://x.com/a', 'x.com/a', 'www.x.com', 'jira.acme.internal', 'a b.com', '']) {
      expect(messageSite('chrome-extension://abc/popup.html', false, claimed)).toBeNull();
    }
  });

  it('an extension page that names no site is not recorded', () => {
    expect(messageSite('chrome-extension://abc/popup.html', false, undefined)).toBeNull();
  });
});
