import { normalizeInstanceUrl } from '../../../../../shared/src/nostr/bridge-key';
import { DirectoryHome, DirectoryInstance, ParsedDirectory } from './types';

/**
 * The directory has no public API and the schema is reverse-engineered, so parse
 * defensively: validate every field, skip malformed instances rather than throw,
 * and identify the live set by `section.online === true` (NOT by presence of
 * `streamingSince`, which appears on offline instances too). See
 * a captured directory-API response.
 */

const EXPECTED_INSTANCE_FIELDS = [
  'id',
  'name',
  'description',
  'streamTitle',
  'url',
  'logo',
  'tags',
  'nsfw',
  'lastSeen',
  'streamingSince',
] as const;

function isValidInstance(raw: unknown): raw is DirectoryInstance {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  // url is the identity key — required and must be a parseable http(s) URL.
  if (typeof o.url !== 'string' || o.url.length === 0) return false;
  try {
    const u = new URL(o.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return true;
}

/** Coerce a loosely-typed instance into our shape with safe defaults. */
function coerceInstance(raw: DirectoryInstance): DirectoryInstance {
  return {
    id: typeof raw.id === 'number' ? raw.id : -1,
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    streamTitle: typeof raw.streamTitle === 'string' ? raw.streamTitle : '',
    url: raw.url,
    logo: typeof raw.logo === 'string' ? raw.logo : '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    nsfw: raw.nsfw === true,
    lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : '',
    streamingSince: typeof raw.streamingSince === 'string' ? raw.streamingSince : '',
  };
}

/**
 * Fingerprint the field shape so drift is observable in logs. Based on the sorted
 * key set of the first instance seen.
 */
function schemaFingerprint(instance: DirectoryInstance | undefined): string {
  if (!instance) return 'empty';
  const keys = Object.keys(instance).sort();
  const known = EXPECTED_INSTANCE_FIELDS.filter((f) => keys.includes(f));
  const extra = keys.filter((k) => !EXPECTED_INSTANCE_FIELDS.includes(k as never));
  return `known:${known.length}/${EXPECTED_INSTANCE_FIELDS.length}${
    extra.length ? `+extra:${extra.join(',')}` : ''
  }`;
}

/** Pure parse of a directory `/api/home` payload. */
export function parseDirectory(payload: unknown, fetchedAt: number): ParsedDirectory {
  const home = payload as DirectoryHome;
  const sections = Array.isArray(home?.sections) ? home.sections : [];

  const seen = new Map<string, DirectoryInstance>();
  const live: DirectoryInstance[] = [];
  const rawLive: unknown[] = [];
  let firstValid: DirectoryInstance | undefined;

  for (const section of sections) {
    const isLiveSection = section?.online === true;
    const instances = Array.isArray(section?.instances) ? section.instances : [];
    for (const raw of instances) {
      if (!isValidInstance(raw)) continue;
      const instance = coerceInstance(raw);
      firstValid = firstValid ?? instance;
      const key = normalizeInstanceUrl(instance.url);
      if (!seen.has(key)) {
        seen.set(key, instance);
        if (isLiveSection) {
          live.push(instance);
          rawLive.push(raw);
        }
      }
    }
  }

  return {
    live,
    rawLive,
    all: [...seen.values()],
    fetchedAt,
    schemaVersion: schemaFingerprint(firstValid),
  };
}

/** Fetch + parse the directory. Throws on network/HTTP error (caller keeps last state). */
export async function fetchDirectory(
  url: string,
  fetchedAt: number,
  timeoutMs = 15_000
): Promise<ParsedDirectory> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Directory fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  return parseDirectory(json, fetchedAt);
}
