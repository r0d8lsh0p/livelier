/**
 * Minimal, dependency-free conversions between Owncast chat HTML and plain text.
 * Owncast delivers chat bodies as HTML (`<p>hi</p>`) and accepts HTML on send.
 */

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

/** Escape untrusted text and wrap for Owncast chat display. */
export function textToOwncastHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br/>');
  return `<p>${escaped}</p>`;
}
