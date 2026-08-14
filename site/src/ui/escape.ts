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
