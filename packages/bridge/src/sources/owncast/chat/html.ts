/**
 * Conversions between Owncast chat HTML and plain text / processed tokens.
 * Owncast delivers chat bodies as HTML (`<p>hi</p>`) and accepts HTML on send.
 */
import { nip19 } from 'nostr-tools';
import type { ContentToken } from '../../../../../shared/src/utils/content-processor';
import type { SourceEmoji } from '../../../core/chat/types';

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Strip tags and decode common entities: Owncast HTML body → plain text. */
export function owncastHtmlToText(html: string): string {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1') // custom emoji → alt text
    .replace(/<[^>]+>/g, '');
  for (const [entity, ch] of Object.entries(NAMED_ENTITIES)) {
    text = text.split(entity).join(ch);
  }
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return text.trim();
}

/**
 * Extract custom emoji from an Owncast chat body: `<img>` tags whose alt is
 * a `:shortcode:`. Relative srcs (Owncast's own `/img/emoji/…` assets)
 * resolve against the instance origin so the URL works off-instance.
 */
export function extractOwncastEmojis(html: string, instanceUrl: string): SourceEmoji[] {
  const seen = new Map<string, string>();
  for (const img of html.match(/<img\b[^>]*>/gi) ?? []) {
    const alt = img.match(/alt="([^"]*)"/i)?.[1] ?? '';
    const src = img.match(/src="([^"]*)"/i)?.[1] ?? '';
    const shortcode = alt.match(/^:([a-zA-Z0-9_-]+):$/)?.[1];
    if (!shortcode || !src || seen.has(shortcode)) continue;
    try {
      const url = new URL(src, instanceUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      seen.set(shortcode, url.href);
    } catch {
      // Unresolvable src — skip this emoji.
    }
  }
  return [...seen.entries()].map(([shortcode, imageUrl]) => ({ shortcode, imageUrl }));
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br/>');
}

/** Escape untrusted text and wrap for Owncast chat display. */
export function textToOwncastHtml(text: string): string {
  return `<p>${escapeText(text)}</p>`;
}

/** Only web URLs may become hrefs — anything else renders as text. */
function isWebUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function anchor(href: string, label: string): string {
  return `<a href="${escapeText(href)}">${escapeText(label)}</a>`;
}

/**
 * Render a processed-content token stream as Owncast chat HTML.
 *
 * Owncast's server-side sanitizer allows `<a>` with remote hrefs but strips
 * remote `<img>` srcs — only the instance's own emoji paths survive. The
 * emoji's identity is its URL: when the tagged image URL IS one of this
 * instance's own emoji assets (`instanceEmojiByUrl`, absolute URL →
 * relative path — the round-trip case), it renders as a real inline
 * `<img>`; any other URL keeps the shortcode linking to that exact image.
 * Bech32 event refs render as their abridged label linking to njump,
 * mentions as @name linking to the profile. All text and labels are
 * escaped; only http(s) URLs from token metadata become hrefs.
 */
export function tokensToOwncastHtml(
  tokens: ContentToken[],
  instanceEmojiByUrl?: Map<string, string>
): string {
  const body = tokens
    .map((token) => {
      if (token.type === 'url' && isWebUrl(token.metadata?.url)) {
        return anchor(token.metadata.url, token.value);
      }
      if (token.type === 'mention' && typeof token.metadata?.pubkey === 'string') {
        try {
          return anchor(`https://njump.me/${nip19.npubEncode(token.metadata.pubkey)}`, token.value);
        } catch {
          return escapeText(token.value);
        }
      }
      if (token.type === 'emoji' && isWebUrl(token.metadata?.imageUrl)) {
        const local = instanceEmojiByUrl?.get(token.metadata.imageUrl);
        if (local) {
          return `<img src="${escapeText(local)}" class="emoji" alt="${escapeText(token.value)}" title="${escapeText(token.value)}"/>`;
        }
        return anchor(token.metadata.imageUrl, token.value);
      }
      return escapeText(token.value);
    })
    .join('');
  return `<p>${body}</p>`;
}
