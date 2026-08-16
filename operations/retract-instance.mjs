#!/usr/bin/env node
// Manually remove an instance's published events from the relays: NIP-09
// kind-5 for the 30311 (by coordinate, bridge-signed) and a blank kind-0
// replacement (instance-signed).
//
// Deliberately NOT automatic: setting discovery off only stops the machine;
// whether already-published history should also disappear is a separate
// operator decision. Refuses to run while discovery is still on (the poller
// would just republish next cycle).
//
// Standalone like every other operations script: DB via lib.mjs, signing via
// nostr-tools, publishing over a raw websocket. The key derivations below
// MUST stay byte-identical with packages/shared/src/nostr/bridge-key.ts —
// a drifted derivation signs as the wrong npub and the retraction silently
// misses. The full-stack e2e runs this script and asserts the 30311 is gone
// from the relay, which is what holds the two implementations together.
//
// Usage: node operations/retract-instance.mjs <url> [--confirm]
//   Dry-run by default. Uses the same env as the worker (.env / process env):
//   relays, DATABASE_URL, BRIDGE_KEY_SECRET / BRIDGE_NSEC.
import 'dotenv/config';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { openDb, fetchInstance } from './lib.mjs';

// ── identity (mirrors shared/nostr/bridge-key.ts + bridge/core/identity.ts) ──

/** scheme + host (+ non-default port) + path, lowercased, no trailing slash. */
export function normalizeInstanceUrl(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.host.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol.toLowerCase()}//${host}${path}`;
}

/** privkey = HMAC-SHA256(secret, "<source>:" + normalizedUrl) */
export function deriveInstancePrivKey(instanceUrl, secret, namespace = 'owncast') {
  if (!secret) throw new Error('deriveInstancePrivKey requires a non-empty secret');
  const message = `${namespace}:${normalizeInstanceUrl(instanceUrl)}`;
  return new Uint8Array(crypto.createHmac('sha256', secret).update(message).digest());
}

/** privkey = HMAC-SHA256(secret, "bridge-identity:self") */
export function deriveBridgeIdentityKey(secret) {
  if (!secret) throw new Error('deriveBridgeIdentityKey requires a non-empty secret');
  return new Uint8Array(crypto.createHmac('sha256', secret).update('bridge-identity:self').digest());
}

/** BRIDGE_NSEC wins when set; else derived from BRIDGE_KEY_SECRET. */
function bridgePrivKey(env) {
  if (env.BRIDGE_NSEC) {
    const { type, data } = nip19.decode(env.BRIDGE_NSEC);
    if (type !== 'nsec') throw new Error('BRIDGE_NSEC is not a valid nsec');
    return data;
  }
  return deriveBridgeIdentityKey(env.BRIDGE_KEY_SECRET ?? '');
}

// ── relays (mirrors bridge/core/config.ts + core/relays.ts resolution) ──

function relayConfig(env) {
  const local = env.LOCAL_RELAY_URL || '';
  const eventRelay = env.EVENT_RELAY_URL || local;
  const chatRelay = env.CHAT_RELAY_URL || local;
  if (!eventRelay || !chatRelay) {
    throw new Error('Set EVENT_RELAY_URL/CHAT_RELAY_URL (or LOCAL_RELAY_URL as the fallback)');
  }
  const publishEnabled = env.NETWORK_PROFILE_PUBLISH_ENABLED === 'true' || env.NETWORK_PROFILE_PUBLISH_ENABLED === '1';
  const networkWrites = (env.NETWORK_PROFILE_WRITE_RELAYS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const profileRelays = publishEnabled
    ? [...new Set([chatRelay, ...(networkWrites.length > 0 ? networkWrites : ['wss://purplepag.es'])])]
    : [chatRelay];
  return { eventRelay, profileRelays };
}

// ── publish: one event to one relay, resolved by the relay's OK ──

function publishTo(relayUrl, event, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(relayUrl);
    const done = (accepted) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(accepted);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg[0] === 'OK' && msg[1] === event.id) done(msg[2] === true);
      } catch { /* ignore non-JSON frames */ }
    });
    ws.on('error', () => done(false));
  });
}

async function publishToAll(relayUrls, event) {
  const results = {};
  for (const url of relayUrls) results[url] = await publishTo(url, event);
  return results;
}

// ── main ──

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: node operations/retract-instance.mjs <url> [--confirm]');
    process.exit(2);
  }

  const { eventRelay, profileRelays } = relayConfig(process.env);
  const db = await openDb();
  const row = await fetchInstance(db, url);
  if (!row) {
    await db.end();
    process.exit(1);
  }
  if (row.discovery_enabled) {
    console.error('Refusing: discovery is still ON for this instance — the poller would');
    console.error('republish within a cycle. First: operations/set-discovery.mjs off.');
    await db.end();
    process.exit(1);
  }

  console.log(`Instance:      ${row.url} (${row.name})`);
  console.log(`Coordinate:    30311:<bridge>:${row.d_tag} on ${eventRelay}`);
  console.log(`Profile:       kind-0 blanked as ${row.pubkey.slice(0, 16)}… on ${profileRelays.join(', ')}`);
  console.log('DB after:      last_published_at/profile_hash cleared, status=ended (row kept)');

  if (!confirm) {
    console.log('\nDRY RUN — nothing published. Re-run with --confirm to execute.');
    await db.end();
    return;
  }

  const bridgeKey = bridgePrivKey(process.env);
  const now = () => Math.floor(Date.now() / 1000);
  const coordinate = `30311:${getPublicKey(bridgeKey)}:${row.d_tag}`;
  const deletion = finalizeEvent(
    {
      kind: 5,
      content: 'instance opted out of bridging',
      tags: [['a', coordinate], ['k', '30311']],
      created_at: now(),
    },
    bridgeKey
  );
  const retract = await publishToAll([eventRelay], deletion);
  console.log(`kind-5 deletion: ${JSON.stringify(retract)}`);

  // kind 0 is replaceable: a blank profile overwrites the bridged one
  // everywhere it was published — no event id needed.
  const instanceKey = deriveInstancePrivKey(row.url, process.env.BRIDGE_KEY_SECRET ?? '', row.source);
  const blankEvent = finalizeEvent({ kind: 0, content: '{}', tags: [], created_at: now() }, instanceKey);
  const blank = await publishToAll(profileRelays, blankEvent);
  console.log(`kind-0 blanked:  ${JSON.stringify(blank)}`);

  // The kind-10002 relay list is replaceable too: an empty-tags replacement
  // removes the retracted instance's pointer everywhere it was published.
  const blankRelayList = finalizeEvent({ kind: 10002, content: '', tags: [], created_at: now() }, instanceKey);
  const blankRl = await publishToAll(profileRelays, blankRelayList);
  console.log(`kind-10002 blanked: ${JSON.stringify(blankRl)}`);

  const accepted =
    Object.values(retract).some(Boolean) &&
    Object.values(blank).some(Boolean) &&
    Object.values(blankRl).some(Boolean);
  if (!accepted) {
    console.error('A relay rejected the retraction — DB markers left in place; re-run.');
    await db.end();
    process.exit(1);
  }

  await db.query(
    "UPDATE bridge_instances SET last_published_at = NULL, profile_hash = NULL, status = 'ended', updated_at = now() WHERE url = $1",
    [row.url]
  );
  console.log('Done. DB markers cleared; row retained.');
  await db.end();
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('retract-instance failed:', err);
    process.exit(1);
  });
}
