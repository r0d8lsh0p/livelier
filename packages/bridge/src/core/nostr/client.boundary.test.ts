import fs from 'fs';
import path from 'path';

/**
 * Boundary guards. Two different walls for two different risks:
 *
 * 1. client.service imports stay in core/nostr/client.ts — one typed
 *    seam. Other shared services (profile.service, …) are welcome
 *    anywhere: the vendored shared stack exists precisely to be inherited;
 *    the facade only fences the low-level client.
 *
 * 2. WRITE containment — the invariant that actually matters. Reads are
 *    unconstrained (a REQ has no network footprint), which means the shared
 *    client's pool now connects to public relays; any publish path that fell
 *    back to "whatever the pool is connected to" would silently write to
 *    them. Every bridge publish must name its target relays explicitly, so
 *    the pool-implicit publish APIs must never appear in bridge code.
 */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const srcRoot = path.resolve(__dirname, '../..');

describe('shared-client boundary', () => {
  it('only core/nostr/client.ts imports client.service', () => {
    const needle = 'services/client' + '.service'; // split so this file exempts itself
    const offenders = walk(srcRoot).filter((file) => {
      if (file.endsWith(`core${path.sep}nostr${path.sep}client.ts`)) return false;
      const body = fs.readFileSync(file, 'utf8');
      return body.includes(needle);
    });
    expect(offenders).toEqual([]);
  });
});

describe('write containment: every publish names its relays', () => {
  // Pool-implicit or write-path shared APIs that would publish to whatever
  // relays the shared client is connected to (now including public ones).
  // These APIs were deleted from the vendored tree; the list is a tripwire
  // against their reintroduction from the upstream stack.
  const forbiddenWriteCalls = [
    'createAndPublishEvent', // client.service: publishes to the client's own relay selection
    '.createProfile(', // profile.service write path
    '.updateProfile(', // profile.service write path
    '.preloadProfile(', // mutates the shared cache — not for the bridge
  ];

  it('no bridge source calls a pool-implicit publish API', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file.endsWith('.test.ts')) continue;
      const body = fs.readFileSync(file, 'utf8');
      for (const call of forbiddenWriteCalls) {
        if (body.includes(call)) offenders.push(`${path.relative(srcRoot, file)}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the facade exposes no publish without an explicit relay list', () => {
    const facade = fs.readFileSync(path.join(srcRoot, 'core', 'nostr', 'client.ts'), 'utf8');
    expect(facade).not.toContain('createAndPublishEvent');
    // publishEvent's facade signature must require the relay list.
    expect(facade).toMatch(/publishEvent\s*\(\s*event[^)]*relayUrls: string\[\]/);
  });
});
