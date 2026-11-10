/**
 * Text that must never leave the device for a grammar check: keys, tokens, card and ID numbers,
 * passwords written out in a sentence. A sentence that contains one is skipped as a whole (it is
 * simply not checked), which is far better than sending a secret to a server and a model provider.
 *
 * Deliberately a little eager: skipping a sentence costs one missing underline.
 */

const PREFIXED_SECRETS = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PGP)[A-Z ]*-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/, //                 OpenAI and similar
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, //            GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, //          Slack
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/, //            AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, //               Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JWT
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // credentials inside a URL
];

/** "password: hunter2", "şifre = abc", "api key: ...", "my password is Winter2026!". */
const LABEL =
  '(?<![\\p{L}\\p{N}_])(?:pass(?:word|wd|code|phrase)?|pwd|secret|token|api[\\s_-]?key|private[\\s_-]?key|parola|şifre|sifre|passwort|kennwort|contraseña|mot de passe)';
const LABELLED_SECRET = new RegExp(`${LABEL}\\s*[:=→]\\s*\\S{3,}`, 'iu');
/** With "is" the value has to look like one (a digit or symbol in it), so "the password is incorrect" is left alone. */
const SPOKEN_SECRET = new RegExp(`${LABEL}\\s+is\\s+(?=\\S*[\\d!@#$%^&*_])\\S{4,}`, 'iu');

/** One unbroken run that looks random: long, mixed letters and digits. Plain long words and URLs paths are fine. */
const LONG_RANDOM_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

function looksRandom(run: string): boolean {
  return /[A-Za-z]/.test(run) && /\d/.test(run) && new Set(run).size >= 12;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 13–19 digits (spaces and dashes allowed) that pass the Luhn check: a payment card. */
function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function hasIban(text: string): boolean {
  for (const match of text.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g)) {
    const compact = match[0].replace(/ /g, '');
    if (compact.length >= 15 && compact.length <= 34 && ibanValid(compact)) return true;
  }
  return false;
}

/** Turkish national ID (TC kimlik no): 11 digits with two check digits. */
function hasTurkishId(text: string): boolean {
  for (const match of text.matchAll(/(?<!\d)[1-9]\d{10}(?!\d)/g)) {
    const d = match[0].split('').map(Number) as number[];
    const tenth = ((d[0]! + d[2]! + d[4]! + d[6]! + d[8]!) * 7 - (d[1]! + d[3]! + d[5]! + d[7]!)) % 10;
    const eleventh = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
    if ((tenth + 10) % 10 === d[9] && eleventh === d[10]) return true;
  }
  return false;
}

/** US social security number, written with dashes. */
const SSN = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/;

export function looksSensitive(text: string): boolean {
  if (text.length < 8) return false;
  if (PREFIXED_SECRETS.some((pattern) => pattern.test(text))) return true;
  if (LABELLED_SECRET.test(text) || SPOKEN_SECRET.test(text)) return true;
  for (const run of text.matchAll(LONG_RANDOM_RUN)) if (looksRandom(run[0])) return true;
  return hasCardNumber(text) || hasIban(text) || hasTurkishId(text) || SSN.test(text);
}
