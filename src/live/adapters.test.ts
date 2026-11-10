// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createAdapter } from './adapters';

function editor(html: string): HTMLElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('ContentEditableAdapter.readText', () => {
  it('turns blocks and <br> into line breaks', () => {
    const el = editor('<p>Hello <b>wrld</b></p><p>Second<br>line</p>');
    expect(createAdapter(el, document.body).readText()).toBe('Hello wrld\nSecond\nline\n');
  });

  it('keeps 1:1 length with the DOM text and normalizes nbsp', () => {
    const el = editor('<div>a b</div>');
    expect(createAdapter(el, document.body).readText()).toBe('a b\n');
  });

  it('skips quoted replies, code and hidden decorations; mentions become one object char', () => {
    const el = editor(
      '<div>Hi <span contenteditable="false">@Ann</span> there</div>' +
        '<pre>const x = 1</pre>' +
        '<span aria-hidden="true">decoration</span>' +
        '<div class="gmail_quote">old message</div>'
    );
    expect(createAdapter(el, document.body).readText()).toBe('Hi ￼ there\n');
  });
});
