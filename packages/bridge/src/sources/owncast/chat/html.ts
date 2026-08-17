/**
 * Conversions between Owncast chat HTML and plain text / processed tokens.
 * Owncast delivers chat bodies as HTML (`<p>hi</p>`) and accepts HTML on send.
 */
import { nip19 } from 'nostr-tools';
import type { ContentToken } from '../../../../../shared/src/utils/content-processor';

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
 * remote `<img>` srcs (only its own admin-managed /img/emoji/ paths
 * survive), so links are the richest form available: bech32 event refs
 * render as their abridged label linking to njump, mentions as @name
 * linking to the profile, and NIP-30 custom emoji as the shortcode linking
 * to its image. All text and labels are escaped; only http(s) URLs from
 * token metadata become hrefs.
 */
export function tokensToOwncastHtml(tokens: ContentToken[]): string {
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
        return anchor(token.metadata.imageUrl, token.value);
      }
      return escapeText(token.value);
    })
    .join('');
  return `<p>${body}</p>`;
}
