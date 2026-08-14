/**
 * Owncast-aware HLS liveness.
 *
 * The generic heuristic (shared `checkHlsLiveness`) is insufficient for Owncast:
 * after a stream ends, Owncast KEEPS serving the master playlist (with
 * `#EXT-X-STREAM-INF`) and a media playlist of offline-slate segments
 * (`stream-offline-*.ts`) with `#EXT-X-MEDIA-SEQUENCE` — both read as "live" to
 * the generic check, so teardown never fires (verified empirically against a
 * local Owncast 2026-08-10). This check stays HLS-only but follows the master
 * playlist to the media playlist and treats the offline slate as ended.
 */
export type OwncastLiveness = 'live' | 'ended' | 'error';

const OFFLINE_SLATE_MARKER = 'stream-offline';

function classifyMediaPlaylist(body: string): OwncastLiveness {
  if (body.includes('#EXT-X-ENDLIST')) return 'ended';
  if (body.includes(OFFLINE_SLATE_MARKER)) return 'ended';
  if (body.includes('#EXT-X-MEDIA-SEQUENCE')) return 'live';
  return 'error';
}

/** First non-comment, non-empty line of a master playlist = first variant URI. */
function firstVariantUri(masterBody: string): string | null {
  for (const raw of masterBody.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line;
  }
  return null;
}

export async function checkOwncastHlsLiveness(
  hlsUrl: string,
  timeoutMs = 10_000
): Promise<OwncastLiveness> {
  try {
    const res = await fetch(hlsUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'error';
    const body = await res.text();

    if (body.includes('#EXT-X-ENDLIST')) return 'ended';

    // Direct media playlist (no variants).
    if (body.includes('#EXT-X-MEDIA-SEQUENCE')) return classifyMediaPlaylist(body);

    // Master playlist: follow the first variant to the media playlist —
    // Owncast serves a master even when offline, so the master alone proves nothing.
    if (body.includes('#EXT-X-STREAM-INF')) {
      const variant = firstVariantUri(body);
      if (!variant) return 'error';
      const variantUrl = new URL(variant, hlsUrl).toString();
      const variantRes = await fetch(variantUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!variantRes.ok) return 'error';
      return classifyMediaPlaylist(await variantRes.text());
    }

    return 'error';
  } catch {
    return 'error';
  }
}
