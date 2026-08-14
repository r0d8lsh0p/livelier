import { owncastHtmlToText, textToOwncastHtml } from './html';

describe('owncastHtmlToText', () => {
  it('strips paragraph wrapper', () => {
    expect(owncastHtmlToText('<p>hello world</p>')).toBe('hello world');
  });

  it('converts br and p boundaries to newlines', () => {
    expect(owncastHtmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(owncastHtmlToText('a<br/>b')).toBe('a\nb');
  });

  it('replaces emoji imgs with alt text and decodes entities', () => {
    expect(owncastHtmlToText('<p>hi <img src="/x.png" alt=":wave:"> &amp; bye &lt;3</p>')).toBe(
      'hi :wave: & bye <3'
    );
  });

  it('decodes numeric entities', () => {
    expect(owncastHtmlToText('&#128512;')).toBe('😀');
  });
});

describe('textToOwncastHtml', () => {
  it('escapes html-sensitive characters', () => {
    expect(textToOwncastHtml('<script>alert("x")</script>')).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>'
    );
  });

  it('converts newlines to br', () => {
    expect(textToOwncastHtml('a\nb')).toBe('<p>a<br/>b</p>');
  });
});
