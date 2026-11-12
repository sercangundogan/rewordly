import { describe, expect, it } from 'vitest';
import { looksSensitive } from './sensitive';

/** Fake keys are put together at run time so secret scanners don't flag this file. */
const k = (...parts: string[]) => parts.join('');

describe('looksSensitive: text that must not be sent', () => {
  it.each([
    ['OpenAI key', `Here is my key ${k('sk-', 'proj-AbCdEf1234567890AbCdEf1234567890')} please check it.`],
    ['Stripe live key', `Use ${k('sk_', 'live_51HabcdefGHIJKLmnopqrstuv')} for payments.`],
    ['GitHub token', `export GH=${k('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789')} and run it.`],
    ['AWS access key id', 'The id is AKIAIOSFODNN7EXAMPLE and the region is eu-west-1.'],
    ['Google API key', `key=${k('AI', 'zaSyA-1234567890abcdefghijklmnopqrstuv')} in the url.`],
    ['Slack token', `${k('xo', 'xb-123456789012-1234567890123-abcdefghijklmnop')} was leaked.`],
    ['JWT', 'Authorization eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk ok?'],
    ['bearer token', 'Send Bearer abcdEFGH1234567890abcdEFGH1234 in the header.'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA'],
    ['credentials in a URL', 'Clone https://deploy:hunter2secret@git.example.com/app.git first.'],
    ['password written out', 'My password is Winter2026! so log in.'],
    ['Turkish password', 'Şifre: kedi1234 olarak ayarladım.'],
    ['api key label', 'api key = 9f8e7d6c5b4a'],
    ['random long run', 'Token a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 expires soon.'],
    ['Visa test card', 'Pay with 4242 4242 4242 4242 tomorrow.'],
    ['card without spaces', 'card 4111111111111111 exp 12/29'],
    ['German IBAN', 'Überweise an DE89 3704 0044 0532 0130 00 bitte.'],
    ['Turkish IBAN', 'IBAN TR33 0006 1005 1978 6457 8413 26 hesabıma yatır.'],
    ['Turkish national ID', 'TC kimlik no 10000000146 ile başvur.'],
    ['US SSN', 'My SSN is 123-45-6789, thanks.'],
  ])('%s', (_label, text) => {
    expect(looksSensitive(text)).toBe(true);
  });
});

describe('looksSensitive: ordinary writing is left alone', () => {
  it.each([
    ['plain sentence', 'I dont know teh answer to that question.'],
    ['Turkish sentence', 'Yarın toplantıya geç kalacağım, lütfen başlayın.'],
    ['a long word', 'The Pneumonoultramicroscopicsilicovolcanoconiosis case was discussed.'],
    ['a long URL path', 'See https://example.com/docs/getting-started/installation-and-configuration-guide for details.'],
    ['a kebab-case slug', 'The branch feature-add-user-authentication-with-oauth-flow is ready.'],
    ['a phone number', 'Call me on 0532 123 45 67 after lunch.'],
    ['an order number', 'Order 20260511 shipped on 11/05/2026.'],
    ['a year and a price', 'In 2026 the price went up to 1299.90 dollars.'],
    ['a 16-digit number that is not a card', 'The serial 1234567890123456 is printed on the box.'],
    ['"the password is incorrect"', 'Sorry, the password is incorrect, please try again.'],
    ['a secret santa', 'We are doing a secret-santa exchange on Friday.'],
    ['the word password in prose', 'You should choose a strong password and change it often.'],
    ['the word token in prose', 'The token economy used in class helped the students.'],
    ['a pull request', 'Please review PR 1482 and merge it to staging.'],
    ['short text', 'ok teh'],
  ])('%s', (_label, text) => {
    expect(looksSensitive(text)).toBe(false);
  });
});
