import { nip19 } from 'nostr-tools';
import { extractOwncastEmojis, owncastHtmlToText, textToOwncastHtml, tokensToOwncastHtml } from './html';

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

describe('extractOwncastEmojis', () => {
  const INSTANCE = 'http://owncast-test:8080';

  it('extracts shortcode and absolute image URL from a real Owncast emoji img', () => {
    const body =
      '<p><img src="/img/emoji/neocat_cry_256.png" class="emoji" alt=":neocat_cry_256:" title=":neocat_cry_256:"></p>';
    expect(extractOwncastEmojis(body, INSTANCE)).toEqual([
      { shortcode: 'neocat_cry_256', imageUrl: 'http://owncast-test:8080/img/emoji/neocat_cry_256.png' },
    ]);
  });

  it('dedupes repeated emoji and ignores imgs without a shortcode alt', () => {
    const body =
      '<p><img src="/img/emoji/a.gif" alt=":a:"> and <img src="/img/emoji/a.gif" alt=":a:">' +
      '<img src="/pic.png" alt="just a picture"></p>';
    expect(extractOwncastEmojis(body, INSTANCE)).toEqual([
      { shortcode: 'a', imageUrl: 'http://owncast-test:8080/img/emoji/a.gif' },
    ]);
  });

  it('keeps absolute http(s) srcs and drops other schemes', () => {
    const body =
      '<img src="https://cdn.example/e.png" alt=":ext:">' +
      '<img src="data:image/png;base64,xx" alt=":bad:">';
    expect(extractOwncastEmojis(body, INSTANCE)).toEqual([
      { shortcode: 'ext', imageUrl: 'https://cdn.example/e.png' },
    ]);
  });

  it('returns empty for a plain text body', () => {
    expect(extractOwncastEmojis('<p>no emoji here</p>', INSTANCE)).toEqual([]);
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

  it('renders an inline img when the tagged URL is one of the instance own assets', () => {
    const instanceEmojiByUrl = new Map([
      ['http://oc:8080/img/emoji/blob/blob-dance.gif', '/img/emoji/blob/blob-dance.gif'],
    ]);
    const html = tokensToOwncastHtml(
      [
        { type: 'text', value: 'gm ' },
        {
          type: 'emoji',
          value: ':blob-dance:',
          metadata: {
            shortcode: 'blob-dance',
            imageUrl: 'http://oc:8080/img/emoji/blob/blob-dance.gif',
          },
        },
      ],
      instanceEmojiByUrl
    );
    expect(html).toBe(
      '<p>gm <img src="/img/emoji/blob/blob-dance.gif" class="emoji" alt=":blob-dance:" title=":blob-dance:"/></p>'
    );
  });

  it('links a foreign emoji URL even when its name matches an instance emoji', () => {
    const instanceEmojiByUrl = new Map([
      ['http://oc:8080/img/emoji/blob/blob-dance.gif', '/img/emoji/blob/blob-dance.gif'],
    ]);
    const html = tokensToOwncastHtml(
      [
        {
          type: 'emoji',
          value: ':blob-dance:',
          metadata: { shortcode: 'blob-dance', imageUrl: 'https://their.site/blob-dance.gif' },
        },
      ],
      instanceEmojiByUrl
    );
    expect(html).toBe('<p><a href="https://their.site/blob-dance.gif">:blob-dance:</a></p>');
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

  it('escapes hostile instance emoji paths inside the img tag', () => {
    const instanceEmojiByUrl = new Map([
      ['https://oc/img/emoji/a.png', '/img/emoji/a.png" onerror="alert(1)'],
    ]);
    const html = tokensToOwncastHtml(
      [
        {
          type: 'emoji',
          value: ':x:',
          metadata: { shortcode: 'x', imageUrl: 'https://oc/img/emoji/a.png' },
        },
      ],
      instanceEmojiByUrl
    );
    expect(html).toBe(
      '<p><img src="/img/emoji/a.png&quot; onerror=&quot;alert(1)" class="emoji" alt=":x:" title=":x:"/></p>'
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
