import { nip19 } from 'nostr-tools';
import { owncastHtmlToText, textToOwncastHtml, tokensToOwncastHtml } from './html';

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

describe('tokensToOwncastHtml', () => {
  const PUBKEY = '1'.repeat(64);

  it('escapes text tokens', () => {
    expect(tokensToOwncastHtml([{ type: 'text', value: 'a <b> & "c"' }])).toBe(
      '<p>a &lt;b&gt; &amp; &quot;c&quot;</p>'
    );
  });

  it('renders url tokens as anchors with the abridged label', () => {
    const html = tokensToOwncastHtml([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'note1ab...cd', metadata: { url: 'https://njump.me/note1abcd' } },
    ]);
    expect(html).toBe('<p>see <a href="https://njump.me/note1abcd">note1ab...cd</a></p>');
  });

  it('renders mentions as anchors to the njump profile', () => {
    const html = tokensToOwncastHtml([
      { type: 'mention', value: '@alice', metadata: { pubkey: PUBKEY, type: 'mention' } },
    ]);
    expect(html).toBe(`<p><a href="https://njump.me/${nip19.npubEncode(PUBKEY)}">@alice</a></p>`);
  });

  it('renders custom emoji as the shortcode linking to its image', () => {
    const html = tokensToOwncastHtml([
      {
        type: 'emoji',
        value: ':blob-dance:',
        metadata: { shortcode: 'blob-dance', imageUrl: 'https://x/blob.png' },
      },
    ]);
    expect(html).toBe('<p><a href="https://x/blob.png">:blob-dance:</a></p>');
  });

  it('refuses non-web URLs as hrefs and falls back to escaped text', () => {
    const html = tokensToOwncastHtml([
      { type: 'url', value: 'x', metadata: { url: 'javascript:alert(1)' } },
      { type: 'emoji', value: ':e:', metadata: { imageUrl: 'data:image/png;base64,x' } },
    ]);
    expect(html).toBe('<p>x:e:</p>');
  });

  it('escapes hostile label and href content inside anchors', () => {
    const html = tokensToOwncastHtml([
      {
        type: 'url',
        value: '"><script>x</script>',
        metadata: { url: 'https://a.example/?q="<x>"' },
      },
    ]);
    expect(html).toBe(
      '<p><a href="https://a.example/?q=&quot;&lt;x&gt;&quot;">&quot;&gt;&lt;script&gt;x&lt;/script&gt;</a></p>'
    );
  });

  it('renders a mixed stream in order', () => {
    const html = tokensToOwncastHtml([
      { type: 'text', value: 'hi ' },
      { type: 'mention', value: '@jack', metadata: { pubkey: PUBKEY } },
      { type: 'text', value: ' see ' },
      { type: 'url', value: 'https://livelier.live', metadata: { url: 'https://livelier.live' } },
    ]);
    expect(html).toBe(
      `<p>hi <a href="https://njump.me/${nip19.npubEncode(PUBKEY)}">@jack</a> see <a href="https://livelier.live">https://livelier.live</a></p>`
    );
  });
});
