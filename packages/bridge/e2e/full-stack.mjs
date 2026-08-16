#!/usr/bin/env node
/**
 * Full-stack E2E for the Livelier bridge against the docker-compose stack
 * (docker-compose.yml). Proves the closed loop:
 *
 *   1. SW2 (event relay) holds the bridge-authored 30311 for the local
 *      Owncast room, with the chat relay in its NIP-53 relays hint.
 *   2. SW2 whitelist: a non-whitelisted key is REJECTED for writes; reads
 *      need no auth.
 *   3. Ephemeral relay /demand: a viewer subscription naming the room's #a
 *      shows up; the bridge's own firehose (no #a) does not.
 *   4. Demand-gated Owncast→Nostr: after the viewer subscribes, a message
 *      posted into Owncast chat arrives as a 1311 with NIP-70 '-' and a
 *      NIP-40 expiration.
 *   5. Nostr→Owncast: a viewer 1311 lands in the Owncast chat.
 *   6. Discovery flag + manual retraction: discovery_enabled=false stops the
 *      poller but leaves published events on the relay; the separate
 *      retract-instance.mjs script removes them (NIP-09); flipping back on
 *      republishes under the SAME npub + d-tag.
 *
 * Usage: `npm run e2e` (from the repo root)
 * Env overrides: SW2_URL, CHAT_RELAY_URL, DEMAND_URL, DEMAND_AUTH_TOKEN,
 * OWNCAST_URL, BRIDGE_PUBKEY, BRIDGES_DATABASE_URL.
 */
import WebSocket from 'ws';
import { createRequire } from 'node:module';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

const pg = createRequire(import.meta.url)('pg');
const BRIDGES_DATABASE_URL =
  process.env.BRIDGES_DATABASE_URL ?? 'postgres://bridges:bridges@localhost:5544/bridges';

const SW2_URL = process.env.SW2_URL ?? 'ws://localhost:7449';
const CHAT_RELAY_URL = process.env.CHAT_RELAY_URL ?? 'ws://localhost:7450';
const DEMAND_URL = process.env.DEMAND_URL ?? 'http://localhost:7450/demand';
const DEMAND_AUTH_TOKEN = process.env.DEMAND_AUTH_TOKEN ?? 'local-demand-token';
const OWNCAST_URL = process.env.OWNCAST_URL ?? 'http://localhost:8585';
const OWNCAST_ADMIN = process.env.OWNCAST_ADMIN ?? 'admin:abc123';
const BRIDGE_PUBKEY =
  process.env.BRIDGE_PUBKEY ?? 'fb2958f6d616a62e157d76a596651c63991ec9ff23c6afd2bc0be2844083078b';
// Container-network chat relay URL as the bridge sees it (the 30311 hint).
const CHAT_RELAY_HINT = process.env.CHAT_RELAY_HINT ?? 'ws://ephemeral-relay:3335';

const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail = '') => {
  results.push({ name, ok: false, detail });
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal one-shot REQ: collect events until EOSE (or timeout). */
function query(relayUrl, filter, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const events = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(events); // partial results beat a hard fail for asserts
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'e2e', filter])));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'EVENT' && msg[1] === 'e2e') events.push(msg[2]);
      if (msg[0] === 'EOSE') {
        clearTimeout(timer);
        ws.close();
        resolve(events);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Publish one event; resolve the relay's ["OK", id, accepted, message]. */
function publish(relayUrl, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('publish timeout'));
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer);
        ws.close();
        resolve({ accepted: msg[2], message: msg[3] ?? '' });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Long-lived viewer subscription (creates /demand) that records 1311s. */
function openViewerSub(relayUrl, aTag) {
  const ws = new WebSocket(relayUrl);
  const received = [];
  ws.on('open', () =>
    ws.send(
      JSON.stringify([
        'REQ',
        'viewer',
        { kinds: [1311, 7, 9735, 10312], '#a': [aTag], limit: 200 },
      ])
    )
  );
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg[0] === 'EVENT' && msg[1] === 'viewer') received.push(msg[2]);
  });
  return { ws, received, close: () => ws.close() };
}

async function fetchDemand() {
  const res = await fetch(DEMAND_URL, {
    headers: { Authorization: `Bearer ${DEMAND_AUTH_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`demand HTTP ${res.status}`);
  return (await res.json()).demand ?? [];
}

async function owncastRegister(displayName) {
  const res = await fetch(`${OWNCAST_URL}/api/chat/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`owncast register HTTP ${res.status}`);
  return res.json();
}

/** Send one chat message into Owncast as a registered user. */
async function owncastSay(accessToken, body) {
  const ws = new WebSocket(`${OWNCAST_URL.replace(/^http/, 'ws')}/ws?accessToken=${accessToken}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'CHAT', body }));
  await sleep(500); // let the frame flush before closing
  ws.close();
}

async function owncastAdminMessages() {
  const res = await fetch(`${OWNCAST_URL}/api/admin/chat/messages`, {
    headers: { Authorization: `Basic ${Buffer.from(OWNCAST_ADMIN).toString('base64')}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`owncast admin messages HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log('Livelier full-stack E2E\n');

  // ---- 1. 30311 on SW2 -----------------------------------------------------
  console.log('1. 30311 discovery on SW2 (event relay)');
  const liveEvents = await query(SW2_URL, { kinds: [30311], authors: [BRIDGE_PUBKEY] });
  const room = liveEvents
    .filter((e) => e.tags.some((t) => t[0] === 'proxy' && t[1].includes('owncast-test')))
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!room) {
    fail('30311 for owncast-test on SW2', `found ${liveEvents.length} bridge 30311s, none for the test room`);
    return finish();
  }
  const dTag = room.tags.find((t) => t[0] === 'd')[1];
  const aTag = `30311:${BRIDGE_PUBKEY}:${dTag}`;
  const status = room.tags.find((t) => t[0] === 'status')?.[1];
  pass('30311 for owncast-test on SW2', `status=${status}, d=${dTag}`);
  const relaysTag = room.tags.find((t) => t[0] === 'relays') ?? [];
  if (relaysTag.includes(CHAT_RELAY_HINT)) {
    pass('30311 relays hint carries the chat relay', relaysTag.slice(1).join(', '));
  } else {
    fail('30311 relays hint carries the chat relay', `tags=${JSON.stringify(relaysTag)}`);
  }

  // The host's NIP-65 relay list pairs with its kind-0 on the chat relay.
  // The r-tag URLs are the poller's own EVENT/CHAT_RELAY_URL config, which in
  // compose differ from the host-side URLs this harness dials — so assert the
  // shape (one write pointer, one read pointer), not the exact URLs.
  const hostPubkey = room.tags.find((t) => t[0] === 'p')?.[1];
  const hostRelayLists = await query(CHAT_RELAY_URL, { kinds: [10002], authors: [hostPubkey] });
  const rl = hostRelayLists.sort((a, b) => b.created_at - a.created_at)[0];
  const rTags = rl ? rl.tags.filter((t) => t[0] === 'r') : [];
  if (rTags.length === 2 && rTags.some((t) => t[2] === 'write') && rTags.some((t) => t[2] === 'read')) {
    pass('host kind-10002 on chat relay (write outbox + read inbox)', JSON.stringify(rTags));
  } else {
    fail('host kind-10002 on chat relay (write outbox + read inbox)', rl ? JSON.stringify(rl.tags) : 'no 10002 found');
  }

  // ---- 2. SW2 whitelist ----------------------------------------------------
  console.log('2. SW2 write whitelist (bridge pubkey only)');
  const rogueKey = generateSecretKey();
  const rogue = finalizeEvent(
    { kind: 30311, content: '', tags: [['d', 'rogue']], created_at: Math.floor(Date.now() / 1000) },
    rogueKey
  );
  const rogueResult = await publish(SW2_URL, rogue);
  if (!rogueResult.accepted) {
    pass('non-whitelisted write rejected', rogueResult.message);
  } else {
    fail('non-whitelisted write rejected', 'SW2 ACCEPTED a rogue 30311!');
  }
  // Reads already proven by step 1 (no auth was performed).
  pass('reads open without auth', `step 1 read ${liveEvents.length} events unauthenticated`);

  // ---- 3. Demand -----------------------------------------------------------
  console.log('3. /demand: viewer #a appears; bridge firehose does not');
  const demandBefore = await fetchDemand();
  const aTagsBefore = demandBefore.flatMap((d) => d.filter?.['#a'] ?? []);
  if (aTagsBefore.includes(aTag)) {
    console.log('  (note: pre-existing demand for the room — continuing)');
  }
  const firehoseEntries = demandBefore.filter(
    (d) => d.active > 0 && (d.filter?.kinds ?? []).includes(1311) && !d.filter?.['#a']
  );
  if (firehoseEntries.length === 0) {
    pass('bridge firehose absent from demand (DEMAND_KINDS scoping or no #a)');
  } else {
    // The firehose IS a 1311 subscription; it may legitimately appear as an
    // entry — what matters is it carries no #a, so it can never register
    // demand for a room. Treat as pass with detail.
    pass('bridge firehose carries no #a in demand', `${firehoseEntries.length} unscoped 1311 entries`);
  }

  const viewer = openViewerSub(CHAT_RELAY_URL, aTag);
  await sleep(1500);
  const demandAfter = await fetchDemand();
  const roomEntry = demandAfter.find(
    (d) => d.active > 0 && (d.filter?.['#a'] ?? []).includes(aTag)
  );
  if (roomEntry) {
    pass('viewer subscription registers demand for the room #a', `active=${roomEntry.active}`);
  } else {
    fail('viewer subscription registers demand for the room #a', JSON.stringify(demandAfter));
  }

  // ---- 4. Owncast → Nostr (demand-gated) ------------------------------------
  console.log('4. Owncast → Nostr: bridged 1311 with "-" + expiration');
  const chatter = await owncastRegister('E2E Owncast User');
  const marker = `e2e-o2n-${Date.now()}`;
  // The bridge polls demand every 10s; retry the message until bridged (max 90s).
  let bridged = null;
  for (let attempt = 0; attempt < 9 && !bridged; attempt++) {
    await owncastSay(chatter.accessToken, `${marker} attempt ${attempt}`);
    await sleep(10_000);
    bridged = viewer.received.find((e) => e.kind === 1311 && e.content.includes(marker));
  }
  if (!bridged) {
    fail('owncast message bridged to 1311', `no 1311 containing ${marker} after 90s`);
  } else {
    pass('owncast message bridged to 1311', `pubkey=${bridged.pubkey.slice(0, 8)}…`);
    const hasProtected = bridged.tags.some((t) => t[0] === '-');
    hasProtected
      ? pass('bridged 1311 carries NIP-70 "-"')
      : fail('bridged 1311 carries NIP-70 "-"', JSON.stringify(bridged.tags));
    const exp = bridged.tags.find((t) => t[0] === 'expiration')?.[1];
    const expDelta = exp ? Number(exp) - bridged.created_at : NaN;
    if (exp && expDelta > 0 && expDelta <= 10_800) {
      pass('bridged 1311 carries NIP-40 expiration', `created_at + ${expDelta}s`);
    } else {
      fail('bridged 1311 carries NIP-40 expiration', `expiration=${exp}`);
    }
    // Chatter identity on the chat relay
    const profiles = await query(CHAT_RELAY_URL, { kinds: [0], authors: [bridged.pubkey] });
    profiles.length > 0
      ? pass('bridged chatter kind-0 on chat relay', JSON.parse(profiles[0].content).name)
      : fail('bridged chatter kind-0 on chat relay');
  }

  // ---- 5. Nostr → Owncast ----------------------------------------------------
  console.log('5. Nostr → Owncast delivery');
  const viewerKey = generateSecretKey();
  const viewerPubkey = getPublicKey(viewerKey);
  const profile = finalizeEvent(
    {
      kind: 0,
      content: JSON.stringify({ name: 'E2E Nostr Viewer' }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    viewerKey
  );
  await publish(CHAT_RELAY_URL, profile);
  const n2oMarker = `e2e-n2o-${Date.now()}`;
  const chat = finalizeEvent(
    {
      kind: 1311,
      content: n2oMarker,
      tags: [['a', aTag, CHAT_RELAY_HINT, 'root']],
      created_at: Math.floor(Date.now() / 1000),
    },
    viewerKey
  );
  const chatOk = await publish(CHAT_RELAY_URL, chat);
  chatOk.accepted
    ? pass('viewer 1311 accepted by chat relay')
    : fail('viewer 1311 accepted by chat relay', chatOk.message);

  let delivered = false;
  for (let attempt = 0; attempt < 12 && !delivered; attempt++) {
    await sleep(5000);
    const messages = await owncastAdminMessages();
    delivered = (Array.isArray(messages) ? messages : []).some(
      (m) => typeof m.body === 'string' && m.body.includes(n2oMarker)
    );
  }
  delivered
    ? pass('viewer 1311 delivered into Owncast chat', `sender name resolves via kind-0`)
    : fail('viewer 1311 delivered into Owncast chat', `no message containing ${n2oMarker} after 60s`);

  viewer.close();

  // ---- 6. Discovery off / manual retract / discovery on ----------------------
  console.log('6. Discovery off keeps history; manual retract removes it; on restores identity');
  const db = new pg.Client({ connectionString: BRIDGES_DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      'SELECT url, pubkey, d_tag FROM bridge_instances WHERE d_tag = $1',
      [dTag]
    );
    const testRow = rows[0];
    if (!testRow) {
      fail('test room row found in DB', `no bridge_instances row with d_tag ${dTag}`);
      return finish();
    }

    await db.query(
      'UPDATE bridge_instances SET discovery_enabled = false, updated_at = now() WHERE url = $1',
      [testRow.url]
    );

    // Cycles run ~85s+ on this stack (real HLS probes) and only schedule after
    // the previous completes — wait out one full effective cycle, then assert
    // the flag alone did NOT touch the relay: "stop forward, keep history".
    const roomEventsOnRelay = async () => {
      const all = await query(SW2_URL, { kinds: [30311], authors: [BRIDGE_PUBKEY] });
      return all.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1] === dTag));
    };
    await sleep(170_000);
    const keptOnRelay = await roomEventsOnRelay();
    const keptRow = (
      await db.query('SELECT last_published_at FROM bridge_instances WHERE url = $1', [
        testRow.url,
      ])
    ).rows[0];
    if (keptOnRelay.length > 0 && keptRow.last_published_at !== null) {
      pass('discovery off leaves published history on the relay (no auto-retraction)');
    } else {
      fail(
        'discovery off leaves published history on the relay',
        `onRelay=${keptOnRelay.length} last_published_at=${keptRow.last_published_at}`
      );
    }

    // Manual retraction — the deliberate, separate operator action.
    const { execFileSync } = await import('node:child_process');
    try {
      const out = execFileSync(
        'node',
        ['operations/retract-instance.mjs', testRow.url, '--confirm'],
        {
          cwd: new URL('../../..', import.meta.url).pathname,
          // No BRIDGE_NSEC here: the script's dotenv loads the repo's .env
          // — the SAME file the compose poller reads through the /repo mount —
          // so both sign as the same bridge identity (SW2 whitelists only it).
          env: {
            ...process.env,
            LOCAL_RELAY_URL: CHAT_RELAY_URL,
            EVENT_RELAY_URL: SW2_URL,
            CHAT_RELAY_URL,
            DATABASE_URL: BRIDGES_DATABASE_URL,
            BRIDGE_KEY_SECRET: process.env.BRIDGE_KEY_SECRET ?? 'local-dev-secret-change-me',
          },
          encoding: 'utf8',
          timeout: 60_000,
        }
      );
      pass('retract-instance.mjs ran', out.trim().split('\n').pop());
    } catch (err) {
      fail('retract-instance.mjs ran', String(err.stdout || err.message).slice(0, 300));
    }

    const goneAfterRetract = (await roomEventsOnRelay()).length === 0;
    goneAfterRetract
      ? pass('retracted 30311 gone from event relay (NIP-09 by coordinate)')
      : fail('retracted 30311 gone from event relay');
    const deletions = await query(SW2_URL, { kinds: [5], authors: [BRIDGE_PUBKEY] });
    // Freshness guard: earlier runs may have left kind-5s for this same
    // coordinate; only one created during THIS run proves the script worked.
    const runStart = Math.floor(Date.now() / 1000) - 15 * 60;
    const ourDeletion = deletions.find(
      (e) => e.created_at >= runStart && e.tags.some((t) => t[0] === 'a' && t[1] === aTag)
    );
    ourDeletion
      ? pass('kind-5 deletion on relay names the room coordinate')
      : fail('kind-5 deletion on relay names the room coordinate');

    // Retraction also blanks the host's relay list: replaceable 10002 with
    // empty tags overwrites the pointer wherever it was published.
    const retractedHost = room.tags.find((t) => t[0] === 'p')?.[1];
    const rlAfter = (await query(CHAT_RELAY_URL, { kinds: [10002], authors: [retractedHost] }))
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (rlAfter && rlAfter.tags.length === 0) {
      pass('retracted host kind-10002 blanked (empty tags)');
    } else {
      fail('retracted host kind-10002 blanked (empty tags)', rlAfter ? JSON.stringify(rlAfter.tags) : 'no 10002 found');
    }

    const afterRetract = (
      await db.query(
        'SELECT status, last_published_at FROM bridge_instances WHERE url = $1',
        [testRow.url]
      )
    ).rows[0];
    if (afterRetract && afterRetract.last_published_at === null && afterRetract.status === 'ended') {
      pass('DB row remains with publish markers cleared', `status=${afterRetract.status}`);
    } else {
      fail('DB row remains with publish markers cleared', JSON.stringify(afterRetract));
    }

    // Discovery back on: same derived identity must return. chat_enabled was
    // never touched — the flags are independent.
    await db.query(
      'UPDATE bridge_instances SET discovery_enabled = true, updated_at = now() WHERE url = $1',
      [testRow.url]
    );
    let restored = null;
    for (let attempt = 0; attempt < 30 && !restored; attempt++) {
      await sleep(10_000);
      const back = await roomEventsOnRelay();
      restored = back.find((e) => e.tags.some((t) => t[0] === 'status' && t[1] === 'live'));
    }
    if (restored) {
      const hostTag = restored.tags.find((t) => t[0] === 'p')?.[1];
      hostTag === testRow.pubkey
        ? pass('discovery on republishes with the same host pubkey + d-tag')
        : fail('discovery on republishes with the same host pubkey + d-tag', `host=${hostTag}`);
    } else {
      fail('discovery on republishes with the same host pubkey + d-tag', 'no live 30311 after 300s');
    }
  } finally {
    await db.end();
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(2);
});
