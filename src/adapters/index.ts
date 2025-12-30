/**
 * Platform Adapters
 * Tüm platform adapter'larını export eder
 */

export { BaseAdapter } from './BaseAdapter';
export { GoogleDocsAdapter } from './GoogleDocs';
export { RedditAdapter } from './Reddit';
export { NotionAdapter } from './Notion';
export { GmailAdapter } from './Gmail';
export { GenericAdapter } from './GenericAdapter';

/**
 * Platform adapter factory
 * Mevcut platforma göre doğru adapter'ı döndürür
 */
import { IPlatformAdapter } from '../types';
import { GoogleDocsAdapter } from './GoogleDocs';
import { RedditAdapter } from './Reddit';
import { NotionAdapter } from './Notion';
import { GmailAdapter } from './Gmail';
import { GenericAdapter } from './GenericAdapter';

export function createPlatformAdapter(
  onGrammarCheck?: (text: string) => Promise<import('../types').GrammarError[]>
): IPlatformAdapter | null {
  const hostname = window.location.hostname.toLowerCase();

  // Google Docs
  if (hostname.includes('docs.google.com')) {
    return new GoogleDocsAdapter(onGrammarCheck);
  }

  // Reddit
  if (hostname.includes('reddit.com')) {
    return new RedditAdapter(onGrammarCheck);
  }

  // Notion
  if (hostname.includes('notion.so')) {
    return new NotionAdapter(onGrammarCheck);
  }

  // Twitter
  if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
    return new GenericAdapter('twitter', onGrammarCheck);
  }

  // Gmail
  if (hostname.includes('mail.google.com') || hostname.includes('gmail.com')) {
    return new GmailAdapter(onGrammarCheck);
  }

  // Medium
  if (hostname.includes('medium.com')) {
    return new GenericAdapter('medium', onGrammarCheck);
  }

  // Diğer platformlar için generic adapter
  return new GenericAdapter('generic', onGrammarCheck);
}

