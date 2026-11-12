// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ineligibleReason, searchReason, secretReason, structuredDataReason } from './targets';

function el(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector('[data-target]') as HTMLElement;
}

describe('searchReason: search and filter fields are skipped', () => {
  it("Medium's header search (plain input, role=combobox)", () => {
    const input = el(
      '<div><input data-target role="combobox" aria-controls="searchResults" aria-expanded="false" aria-label="search" data-testid="headerSearchInput" placeholder="Search" value="Test denemeee"></div>'
    );
    expect(searchReason(input)).not.toBeNull();
  });

  it.each([
    ['search landmark', '<form role="search"><input data-target type="text"></form>'],
    ['<search> element', '<search><input data-target></search>'],
    ['search form action', '<form action="/search"><input data-target></form>'],
    ['name=q', '<input data-target name="q">'],
    ['searchbox role on an editor', '<div data-target contenteditable="true" role="searchbox"></div>'],
    ['search keyboard hint', '<input data-target enterkeyhint="search">'],
    ['suggestion list', '<input data-target aria-autocomplete="list">'],
    ['camelCase test id', '<input data-target data-testid="SearchBoxInput">'],
    ['kebab-case id', '<input data-target id="site-search-field">'],
    ['Turkish placeholder', '<input data-target placeholder="Ara...">'],
    ['German label', '<label for="f">Suchen</label><input data-target id="f">'],
    ['Japanese placeholder', '<input data-target placeholder="検索">'],
    ['filter field', '<input data-target placeholder="Filter by name">'],
  ])('%s', (_label, html) => {
    expect(searchReason(el(html))).not.toBeNull();
  });
});

describe('searchReason: writing fields are kept', () => {
  it.each([
    ['comment textarea', '<textarea data-target name="comment[body]" placeholder="Leave a comment"></textarea>'],
    ['X post box (rich editor with @mention suggestions)', '<div data-target contenteditable="true" role="textbox" aria-autocomplete="list" aria-label="Post text"></div>'],
    ['Gmail-like body', '<div data-target contenteditable="true" role="textbox" aria-label="Message Body"></div>'],
    ['word containing "search"', '<textarea data-target id="research-notes" placeholder="Your research notes"></textarea>'],
    ['subject line', '<input data-target name="subject" placeholder="Subject">'],
    ['Turkish comment placeholder', '<textarea data-target placeholder="Yorumunuzu yazın"></textarea>'],
    ['Slack composer: a person named like a search word', '<div data-target contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message to Ara Yilmaz"></div>'],
    ['Discord composer: a channel named like a search word', '<div data-target contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message #search-help"></div>'],
    ['WhatsApp composer', '<div data-target contenteditable="true" role="textbox" aria-multiline="true" aria-label="Type to Bul" aria-placeholder="Type a message"></div>'],
    ['help-desk reply box', '<textarea data-target placeholder="Find the answer or reply to the customer"></textarea>'],
  ])('%s', (_label, html) => {
    expect(searchReason(el(html))).toBeNull();
  });
});

describe('ineligibleReason: opt-outs', () => {
  it('data-gramm="false" asks Grammarly to stay out and does not exclude us (Slack sets it)', () => {
    const field = el('<div data-target contenteditable="true" data-gramm="false" data-enable-grammarly="false"></div>');
    expect(ineligibleReason(field)).not.toMatch(/opted out/);
  });

  it('data-rewordly-ignore on the field or an ancestor does', () => {
    expect(ineligibleReason(el('<textarea data-target data-rewordly-ignore></textarea>'))).toMatch(/opted out/);
    expect(ineligibleReason(el('<div data-rewordly-ignore><textarea data-target></textarea></div>'))).toMatch(/opted out/);
  });
});

describe('structuredDataReason: inputs for dates, numbers and contact details are skipped', () => {
  it.each([
    ['date picker (numeric keyboard, format placeholder)', '<input data-target class="pcx-input__control" inputmode="numeric" autocomplete="off" placeholder="MM/DD/YYYY" value="11/05/2026">'],
    ['format placeholder only', '<input data-target placeholder="DD.MM.YYYY">'],
    ['Turkish format placeholder', '<input data-target placeholder="GG.AA.YYYY">'],
    ['French format placeholder', '<input data-target placeholder="JJ/MM/AAAA">'],
    ['time placeholder', '<input data-target placeholder="HH:MM">'],
    ['picker popup', '<input data-target aria-haspopup="dialog" placeholder="Pick one">'],
    ['decimal keyboard', '<input data-target inputmode="decimal">'],
    ['named like a date', '<input data-target name="startDate">'],
    ['labelled as a phone number', '<label for="p">Phone number</label><input data-target id="p">'],
    ['Turkish label', '<label for="t">Doğum tarihi</label><input data-target id="t">'],
    ['amount field', '<input data-target id="invoice-amount" placeholder="0.00">'],
  ])('%s', (_label, html) => {
    expect(structuredDataReason(el(html))).not.toBeNull();
  });
});

describe('structuredDataReason: prose fields are kept', () => {
  it.each([
    ['subject line', '<input data-target name="subject" placeholder="Subject">'],
    ['title with a word containing "date"', '<input data-target name="update-title" placeholder="What did you update?">'],
    ['textarea, even when named like data', '<textarea data-target name="date-notes" inputmode="numeric"></textarea>'],
    ['rich editor', '<div data-target contenteditable="true" aria-label="Add a date or a note"></div>'],
    ['sentence placeholder with slashes', '<input data-target placeholder="Yes/No and why">'],
    ['suggestion list is search, not a picker', '<input data-target aria-haspopup="listbox" placeholder="Title">'],
  ])('%s', (_label, html) => {
    expect(structuredDataReason(el(html))).toBeNull();
  });
});

describe('secretReason: fields for passwords, keys and card numbers are skipped', () => {
  it.each([
    ['a password input', '<input data-target type="password">'],
    ['a password input whose "show" toggle made it type=text', '<input data-target type="text" name="loginPassword" autocomplete="off" spellcheck="true">'],
    ['id with camelCase', '<input data-target type="text" id="confirmPassword">'],
    ['Turkish name', '<input data-target type="text" name="parola">'],
    ['Turkish label', '<label for="s">Şifre</label><input data-target id="s">'],
    ['aria-label', '<input data-target aria-label="Enter your password">'],
    ['api key', '<input data-target name="api_key">'],
    ['secret key pair', '<input data-target id="secret-key">'],
    ['otp', '<input data-target name="otp">'],
    ['pin', '<input data-target placeholder="Enter PIN">'],
    ['card number by name', '<input data-target name="cardNumber">'],
    ['cvv', '<input data-target name="cvv">'],
    ['iban', '<input data-target id="iban">'],
    ['a textarea for a private key', '<textarea data-target name="private_key"></textarea>'],
    ['a textarea for a token', '<textarea data-target id="access-token"></textarea>'],
    ['react form control name', '<input data-target formcontrolname="newPassword">'],
  ])('%s', (_label, html) => {
    expect(secretReason(el(html))).not.toBeNull();
    expect(ineligibleReason(el(html))).toMatch(/secret|structured|spellcheck/);
  });

  it.each([
    ['a chat composer whose label mentions a team called Pin', '<div data-target contenteditable="true" aria-label="Message to Pin Code Team"></div>'],
    ['a textarea with a prose placeholder', '<textarea data-target placeholder="Write a note about the secret santa party"></textarea>'],
    ['a comment box', '<textarea data-target name="comment[body]" placeholder="Leave a comment"></textarea>'],
    ['word containing pin', '<input data-target name="shipping-notes" placeholder="Shipping notes">'],
    ['word containing token', '<textarea data-target name="tokenizer-feedback"></textarea>'],
    ['a subject line', '<input data-target name="subject" placeholder="Subject">'],
    ['key points', '<textarea data-target name="key-points" placeholder="Key points"></textarea>'],
  ])('%s is kept', (_label, html) => {
    expect(secretReason(el(html))).toBeNull();
  });
});
