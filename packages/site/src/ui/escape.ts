const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Everything rendered from relay data goes through here — it is all untrusted. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

/** Additionally neutralises the backtick, for values landing in an attribute. */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

const SAFE_SCHEMES = new Set(['http:', 'https:']);

/**
 * A URL from a relay, or null if it isn't one this page will link to.
 *
 * Escaping is not enough for `href` and `src`: `javascript:alert(1)` survives
 * entity encoding intact and runs on click. Every address rendered here arrives
 * in an event the bridge published on someone else's behalf, so the scheme is
 * checked rather than assumed — and a caller that gets null renders the value
 * as text instead of as a link.
 */
export function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return SAFE_SCHEMES.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * "2 hours 47 minutes ago", "in 13 minutes".
 *
 * Deliberately precise to the minute: these timestamps sit beside a three-hour
 * deletion window, and a message rounded to "3 hours ago" reads as though it
 * has outlived the guarantee when it has minutes left to run.
 */
export function preciseDelta(unixSeconds: number, now = Date.now() / 1000): string {
  const delta = unixSeconds - now;
  const ahead = delta > 0;
  const total = Math.abs(Math.round(delta));

  if (total < 60) return ahead ? 'in under a minute' : 'moments ago';

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);

  const phrase = parts.join(' ');
  return ahead ? `in ${phrase}` : `${phrase} ago`;
}
