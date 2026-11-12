// Fixture + mock API server for the live checker e2e tests.
// Serves test/e2e/fixtures and a deterministic POST /api/check that flags a few known typos.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURES = join(__dirname, 'fixtures');
const TYPOS: Record<string, string> = { teh: 'the', dont: "don't", recieve: 'receive', wierd: 'weird', statusss: 'status' };

export const stats = {
  /** How long /api/check takes to answer. */
  latencyMs: 250,
  checks: 0,
  paragraphs: 0,
  limitAfter: Infinity,
  /** Quota reported back to the extension; null = a comfortable default. */
  quota: null as null | { tier: string; period: string; used: number; limit: number },
  /** Rows received on POST /api/events. */
  events: [] as Array<{ host: string; event: string; count: number; chars: number }>,
  /** Characters and texts received on POST /api/check, to see what was (and was not) sent. */
  chars: 0,
  texts: [] as string[],
  /** Every /api/check request fails with a 500 (a server that is down). */
  failAll: false,
  /** Requests that failed, for counting retries. */
  failures: 0,
  /** Fingerprints received on POST /api/feedback (suggestions someone ignored). */
  feedback: [] as string[],
};

/** A reply from a broken or hostile server: markup in the text fields, and every kind of impossible range. */
function malicious(text: string) {
  const html = '<img src=x onerror="window.__pwned=1">';
  const valid = { offset: 0, length: 9, original: 'MALICIOUS', replacements: [html], message: html, type: 'grammar' };
  const typo = text.indexOf('teh');
  return [
    valid,
    ...(typo >= 0 ? [{ offset: typo, length: 3, original: 'teh', replacements: ['the'], message: 'typo', type: 'spelling' }] : []),
    { offset: -5, length: 9, original: 'MALICIOUS', replacements: ['x'], message: '', type: 'grammar' },
    { offset: 1e9, length: 3, original: 'teh', replacements: ['x'], message: '', type: 'grammar' },
    { offset: 0, length: 9, original: 'NOT-THERE', replacements: ['x'], message: '', type: 'grammar' },
    { offset: 3, length: 4, original: 'ICIO', message: 'no replacements', type: 'grammar' },
    { offset: 'x', length: 1, original: 'M', replacements: ['x'] },
    null,
    7,
    ...Array.from({ length: 3000 }, () => valid),
  ];
}

function check(text: string) {
  if (text.includes('MALICIOUS')) return malicious(text);
  const issues: object[] = [];
  // A stray trailing word to delete, reported like the real API does: with its leading space.
  // A stray word to delete. Sentences arrive on their own, so it is usually the whole text.
  for (const match of text.matchAll(/(?:^|(?<= ))asd\b/g)) {
    issues.push({ offset: match.index!, length: 3, original: 'asd', replacements: [''], message: 'Remove this', type: 'grammar' });
  }
  // An inconsistent model: removes the comma after "dass", then wants it back once it is gone.
  for (const match of text.matchAll(/\bdass(,?)/g)) {
    const comma = match[1] === ',';
    issues.push({
      offset: match.index!,
      length: match[0].length,
      original: match[0],
      replacements: [comma ? 'dass' : 'dass,'],
      message: comma ? 'No comma here' : 'Add a comma',
      type: 'punctuation',
    });
  }
  // Like the model: always wants "var" after "yanlışın", even when it is already there.
  for (const match of text.matchAll(/yanlışın/g)) {
    issues.push({ offset: match.index!, length: 8, original: 'yanlışın', replacements: ['yanlışın var'], message: 'missing verb', type: 'grammar' });
  }
  for (const match of text.matchAll(/\p{L}+/gu)) {
    const fix = TYPOS[match[0]];
    if (fix) {
      issues.push({ offset: match.index!, length: match[0].length, original: match[0], replacements: [fix], message: 'Possible typo', type: 'spelling' });
    }
  }
  return issues;
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Anonymous-Id',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export function startServer(port: number): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') return send(res, 200);
    if (req.url === '/api/check' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { paragraphs } = JSON.parse(raw) as { paragraphs: Array<{ id: string; text: string }> };
      stats.checks++;
      stats.paragraphs += paragraphs.length;
      stats.chars += paragraphs.reduce((sum, p) => sum + p.text.length, 0);
      stats.texts.push(...paragraphs.map((p) => p.text));
      await new Promise((r) => setTimeout(r, stats.latencyMs));
      // A broken server, or one that chokes on a particular sentence.
      if (stats.failAll || paragraphs.some((p) => p.text.includes('POISON'))) {
        stats.failures++;
        return send(res, 500, { error: 'boom' });
      }
      const quota = stats.quota ?? { tier: 'anonymous', period: 'lifetime', used: stats.paragraphs * 30, limit: 15000 };
      if (stats.checks > stats.limitAfter) {
        return send(res, 402, {
          code: 'LIMIT_REACHED',
          message: 'Your free trial is over.',
          requireLogin: true,
          requirePayment: false,
          results: [],
          quota: { ...quota, used: quota.limit },
        });
      }
      return send(res, 200, {
        // Like the real API, every issue carries a fingerprint of its sentence and position.
        results: paragraphs.map((p) => ({
          id: p.id,
          language: 'en',
          issues: (check(p.text) as Array<{ offset: number; original: string } | null>).map((i) =>
            i && typeof i === 'object' ? { ...i, fp: createHash('sha1').update(`${p.text}\n${i.offset}\n${i.original}`).digest('hex') } : i
          ),
        })),
        quota,
      });
    }
    // Selection flows (floating button / context menu / shortcuts).
    if ((req.url === '/api/rewrite' || req.url === '/api/grammar') && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { text } = JSON.parse(raw) as { text: string };
      const fixed = text.replace(/\p{L}+/gu, (w) => TYPOS[w] ?? w);
      return send(res, 200, req.url === '/api/rewrite' ? { rewritten: `Rewritten: ${fixed}`, variants: [`Rewritten: ${fixed}`] } : { corrected: fixed });
    }
    if (req.url === '/api/feedback' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      stats.feedback.push(...(JSON.parse(raw) as { fps: string[] }).fps);
      return send(res, 204);
    }
    if (req.url === '/api/events' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      stats.events.push(...(JSON.parse(raw) as { events: typeof stats.events }).events);
      return send(res, 204);
    }
    if (req.url === '/api/usage') return send(res, 200, { rewriteUsed: 0, grammarUsed: 0, rewriteLimit: 5, grammarLimit: 5 });

    const file = req.url === '/' || !req.url ? 'editors.html' : req.url.slice(1).split('?')[0]!;
    try {
      const body = await readFile(join(FIXTURES, file));
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(body);
    } catch {
      send(res, 404, { error: 'not found' });
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
