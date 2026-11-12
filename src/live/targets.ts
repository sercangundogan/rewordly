/**
 * Decides which editable elements the live checker attaches to.
 */

import { MARK as SPELLCHECK_MARK } from './native-spellcheck';

export type TextField = HTMLTextAreaElement | HTMLInputElement;
export type LiveTarget = TextField | HTMLElement;

/** Hosts where the visible text is not in the DOM (canvas renderers) or checking makes no sense. */
const UNSUPPORTED_HOSTS = [/^docs\.google\.com$/, /^sheets\.google\.com$/, /^slides\.google\.com$/];

/** Code editors and other widgets whose text is not prose. */
const EXCLUDED_ANCESTORS = [
  '.cm-editor',
  '.CodeMirror',
  '.monaco-editor',
  '.ace_editor',
  '.ql-code-block',
  'pre',
  'code',
  '[data-rewordly-ignore]',
  // Code blocks inside rich editors, where the code is a block of its own (Notion's code block
  // is its own editable; Slack's and others' are inside the message editor, see adapters.ts).
  '.notion-code-block',
  '[class*="code-block" i]',
  '[class*="codeblock" i]',
].join(',');
// Not here on purpose: data-gramm="false" and data-enable-grammarly="false". They ask Grammarly
// (the extension) to stay out of a field, mostly so its injected markup can't break the editor
// (Slack's composer has it), and say nothing about other tools. We don't inject into the field.

/** Autocomplete hints for data that is never prose. */
const EXCLUDED_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code|username|email|tel|url|street-address|postal-code)/;

/** Containers that hold a search form, by standard markup. */
const SEARCH_CONTAINERS = 'search, [role="search"]';

/** Roles of widgets that take a query or pick from suggestions, not prose. */
const SEARCH_ROLES = new Set(['search', 'searchbox', 'combobox']);

/**
 * Words that mark a field as search/filter in attribute names and labels, in the languages we
 * see most. Matched against whole words after splitting camelCase, kebab-case and snake_case,
 * so "headerSearchInput" matches but "research-notes" does not.
 */
const SEARCH_WORDS = new Set([
  'search', 'searchbox', 'searchbar', 'searchfield', 'searchinput', 'query', 'find', 'filter', 'lookup',
  'ara', 'arama', 'bul', 'suche', 'suchen', 'buscar', 'busca', 'busqueda', 'búsqueda', 'recherche', 'rechercher',
  'cerca', 'ricerca', 'pesquisa', 'pesquisar', 'zoeken', 'szukaj', 'поиск', 'найти', 'بحث', 'खोज',
]);
/** Scripts without spaces between words: a substring is enough. */
const SEARCH_SUBSTRINGS = ['検索', '搜索', '搜尋', '검색'];

/** Attributes whose words describe what a field is for. */
const DESCRIPTIVE_ATTRIBUTES = ['name', 'id', 'aria-label', 'placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'data-testid'];

const MIN_FIELD_WIDTH = 60;

/**
 * Whole words that mark a field as holding a secret or a payment/identity number, in the languages we
 * see most. A password field whose "show" toggle turned it into type=text is the usual way these get here.
 */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'secret', 'token', 'apikey', 'otp', 'totp', 'mfa', '2fa',
  'pin', 'cvv', 'cvc', 'cvv2', 'ssn', 'iban', 'swift', 'creditcard', 'cardnumber', 'cardno', 'tckn', 'tcno',
  'parola', 'sifre', 'şifre', 'passwort', 'kennwort', 'contraseña', 'contrasena', 'motdepasse',
]);
/** Pairs written as two words: api key, secret key, access token, card number ... */
const SECRET_PAIRS: Array<[string, string]> = [
  ['api', 'key'], ['secret', 'key'], ['private', 'key'], ['access', 'key'], ['access', 'token'], ['auth', 'token'],
  ['client', 'secret'], ['credit', 'card'], ['card', 'number'], ['security', 'code'], ['verification', 'code'],
  ['kart', 'numarası'], ['kart', 'numarasi'], ['mot', 'de'],
];

function hasSecretWord(value: string | null): boolean {
  if (!value) return false;
  const found = words(value);
  if (found.some((w) => SECRET_WORDS.has(w))) return true;
  return SECRET_PAIRS.some(([a, b]) => found.some((w, i) => w === a && found[i + 1] === b));
}

/** Attributes that say what a field is for in code (not text shown to people, which in a composer can be anything). */
const CODE_ATTRIBUTES = ['name', 'id', 'autocomplete', 'data-testid', 'data-test', 'data-cy', 'formcontrolname'];

/** Keyboards for data, not words. */
const DATA_INPUT_MODES = new Set(['numeric', 'decimal', 'tel', 'email', 'url']);

/** Popups a single-line input opens to pick a value (date pickers, menus), unlike a suggestion list. */
const PICKER_POPUPS = new Set(['dialog', 'grid', 'menu', 'tree', 'true']);

/**
 * A placeholder that shows the expected format: MM/DD/YYYY, DD.MM.YYYY, HH:MM, GG.AA.YYYY,
 * JJ/MM/AAAA. Two or more groups of format letters joined by / . - or :.
 */
const FORMAT_PLACEHOLDER = /^\s*[dmyhsgajtw]{1,4}(?:\s*[/.:-]\s*[dmyhsgajtw]{1,4}){1,2}\s*$/i;

/**
 * Words that mark a single-line input as structured data (dates, times, numbers, contact
 * details) in its name, id, label or placeholder. Whole words, as for search.
 */
const DATA_WORDS = new Set([
  'date', 'datepicker', 'daterange', 'timepicker', 'datetime', 'calendar', 'dob', 'birthday', 'birthdate',
  'phone', 'zip', 'zipcode', 'postcode', 'postal', 'amount', 'price', 'quantity', 'qty', 'iban',
  // Turkish, with the possessive forms labels use ("Doğum tarihi", "Telefon numarası").
  'tarih', 'tarihi', 'saat', 'saati', 'telefon', 'telefonu', 'tutar', 'tutarı', 'fiyat', 'fiyatı', 'adet', 'adedi',
  'datum', 'fecha',
]);

function words(value: string): string[] {
  return value
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function describesSearch(value: string | null): boolean {
  if (!value) return false;
  return words(value).some((w) => SEARCH_WORDS.has(w)) || SEARCH_SUBSTRINGS.some((s) => value.includes(s));
}

/** The field's label element(s), via aria-labelledby or <label for>. */
function labelText(el: LiveTarget): string {
  const ids = el.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts = ids.map((id) => root.getElementById?.(id)?.textContent ?? '');
  if (isTextField(el)) parts.push(...Array.from(el.labels ?? []).map((l) => l.textContent ?? ''));
  return parts.join(' ').slice(0, 200);
}

/**
 * Search boxes, filters and autocomplete inputs hold queries, not prose: checking them wastes
 * the user's quota and draws underlines under search terms. Recognised from standard markup
 * first (roles, <search>, enterkeyhint), then from how the field is named or labelled.
 */
export function searchReason(el: LiveTarget): string | null {
  const role = el.getAttribute('role');
  if (role && SEARCH_ROLES.has(role)) return `role="${role}"`;
  if (el.closest(SEARCH_CONTAINERS)) return 'inside a search form';
  if (el.getAttribute('enterkeyhint') === 'search' || el.getAttribute('inputmode') === 'search') return 'search keyboard hint';

  if (el instanceof HTMLInputElement) {
    // Single-line inputs with suggestions are search/tag/address pickers. Not applied to rich
    // editors: X's post box sets aria-autocomplete for @mentions.
    const autocomplete = el.getAttribute('aria-autocomplete');
    if (autocomplete === 'list' || autocomplete === 'both') return `aria-autocomplete="${autocomplete}"`;
    if (el.getAttribute('aria-haspopup') === 'listbox') return 'opens a suggestion list';
    if (el.name === 'q' || el.name === 's') return `name="${el.name}"`;
    if (describesSearch(el.form?.getAttribute('action') ?? null)) return 'inside a search form';
  }

  // Multi-line fields are for writing, and chat composers put people's and channels' names in
  // their labels ("Message to Ara", "Message #search-help"), which are not search words.
  if (el instanceof HTMLTextAreaElement || el.getAttribute('aria-multiline') === 'true') return null;

  for (const attr of DESCRIPTIVE_ATTRIBUTES) {
    if (describesSearch(el.getAttribute(attr))) return `${attr} looks like search`;
  }
  if (describesSearch(labelText(el))) return 'label looks like search';
  return null;
}

/**
 * Single-line inputs that take structured data (a date picker, a phone number, an amount) rather
 * than prose: there is nothing to correct, and a badge or underline gets in the way. Recognised from
 * the keyboard hint, a format placeholder, a picker popup, then how the field is named or labelled.
 */
export function structuredDataReason(el: LiveTarget): string | null {
  if (!(el instanceof HTMLInputElement)) return null;
  const mode = el.getAttribute('inputmode');
  if (mode && DATA_INPUT_MODES.has(mode)) return `inputmode="${mode}"`;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && FORMAT_PLACEHOLDER.test(placeholder)) return `format placeholder "${placeholder}"`;
  const popup = el.getAttribute('aria-haspopup');
  if (popup && PICKER_POPUPS.has(popup)) return `opens a picker (aria-haspopup="${popup}")`;
  for (const attr of DESCRIPTIVE_ATTRIBUTES) {
    const value = el.getAttribute(attr);
    if (value && words(value).some((w) => DATA_WORDS.has(w))) return `${attr} looks like data`;
  }
  if (words(labelText(el)).some((w) => DATA_WORDS.has(w))) return 'label looks like data';
  return null;
}

/**
 * Fields that hold secrets or payment/identity numbers. Applies to every kind of field: a password
 * input whose "show" toggle made it type=text, a token box, a card form. Single-line inputs are also
 * recognised by their visible label and placeholder; multi-line fields only by how the code names
 * them, because chat composers can have any label ("Message to Pin Code Team").
 */
export function secretReason(el: LiveTarget): string | null {
  if (el instanceof HTMLInputElement && el.type === 'password') return 'password field';
  for (const attr of CODE_ATTRIBUTES) {
    if (hasSecretWord(el.getAttribute(attr))) return `${attr} looks like a secret`;
  }
  if (el instanceof HTMLInputElement) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      if (hasSecretWord(el.getAttribute(attr))) return `${attr} looks like a secret`;
    }
    if (hasSecretWord(labelText(el))) return 'label looks like a secret';
  }
  return null;
}

export function isSupportedPage(): boolean {
  return !UNSUPPORTED_HOSTS.some((re) => re.test(location.hostname));
}

export function isTextField(el: Element): el is TextField {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && isTextInput(el));
}

function isTextInput(el: HTMLInputElement): boolean {
  // Only free-text inputs; search boxes are short queries, not prose.
  return el.type === 'text' || el.type === '';
}

/**
 * Resolves an event's real target (through open shadow roots) to the field to check:
 * a textarea/text input, or the outermost contenteditable host.
 */
export function resolveTarget(event: Event): LiveTarget | null {
  const path = event.composedPath();
  const first = path[0];
  if (!(first instanceof Element)) return null;

  if (isTextField(first)) return isEligible(first) ? first : null;

  const start = first instanceof HTMLElement ? first : first.parentElement;
  if (!start?.isContentEditable) return null;

  let host: HTMLElement = start;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return isEligible(host) ? host : null;
}

export function isEligible(el: LiveTarget): boolean {
  const reason = ineligibleReason(el);
  if (reason) debug('skipping field:', reason, el);
  return reason === null;
}

export function ineligibleReason(el: LiveTarget): string | null {
  if (el.closest(EXCLUDED_ANCESTORS)) return 'inside a code editor or opted out (data-rewordly-ignore)';
  if (el.getAttribute('aria-readonly') === 'true') return 'read-only';
  const search = searchReason(el);
  if (search) return `search field (${search})`;
  const secret = secretReason(el);
  if (secret) return `secret (${secret})`;
  const data = structuredDataReason(el);
  if (data) return `structured data (${data})`;
  if (el.getBoundingClientRect().width < MIN_FIELD_WIDTH) return 'too narrow';

  if (isTextField(el)) {
    // Only for plain fields: rich editors (Draft.js, used by X) disable native spellcheck by default.
    if (el.getAttribute('spellcheck') === 'false' && !el.hasAttribute(SPELLCHECK_MARK)) return 'spellcheck="false"';
    if (el.readOnly || el.disabled) return 'read-only or disabled';
    if (EXCLUDED_AUTOCOMPLETE.test(el.autocomplete || '')) return `autocomplete="${el.autocomplete}"`;
  }
  return null;
}

declare const process: { env: Record<string, string | undefined> };

/** At most this many lines per window: a flood in the console is itself enough to slow a page to a crawl. */
const DEBUG_LINES_PER_WINDOW = 40;
const DEBUG_WINDOW_MS = 5000;
let debugWindow = { since: 0, left: DEBUG_LINES_PER_WINDOW, dropped: 0 };

/** Dev builds only: explains what the live checker is doing in the page console. */
export function debug(...args: unknown[]): void {
  if (process.env['NODE_ENV'] === 'production') return;
  const now = Date.now();
  if (now - debugWindow.since > DEBUG_WINDOW_MS) {
    if (debugWindow.dropped > 0) console.info('[Rewordly live]', `… ${debugWindow.dropped} more lines suppressed`);
    debugWindow = { since: now, left: DEBUG_LINES_PER_WINDOW, dropped: 0 };
  }
  if (debugWindow.left-- <= 0) {
    debugWindow.dropped++;
    return;
  }
  console.info('[Rewordly live]', ...args);
}
