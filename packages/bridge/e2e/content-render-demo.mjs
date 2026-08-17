#!/usr/bin/env node
/**
 * Content-render demo against the docker-compose stack: publishes one viewer
 * kind-1311 per processed content type (mentions, bech32 event refs, URLs,
 * custom emoji, and a mixed message) into the local room, then reads the
 * Owncast chat back so an operator can see exactly how each type renders on
 * the source side. Messages are left in the Owncast chat for visual review.
 *
 * Prereqs: compose stack up with the chat gates exported, an ffmpeg feed
 * into owncast-test, and the manual row seeded (this script seeds/repairs
 * the row itself). Usage: `node e2e/content-render-demo.mjs` from
 * packages/bridge.
 *
 * Env overrides: SW2_URL, CHAT_RELAY_URL, DEMAND_URL, DEMAND_AUTH_TOKEN,
 * OWNCAST_URL, OWNCAST_ADMIN, BRIDGES_DATABASE_URL, REPORT_PATH.
 */
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const pg = createRequire(import.meta.url)('pg');

const BRIDGES_DATABASE_URL =
  process.env.BRIDGES_DATABASE_URL ?? 'postgres://bridges:bridges@localhost:5544/bridges';
const SW2_URL = process.env.SW2_URL ?? 'ws://localhost:7449';
const CHAT_RELAY_URL = process.env.CHAT_RELAY_URL ?? 'ws://localhost:7450';
const DEMAND_URL = process.env.DEMAND_URL ?? 'http://localhost:7450/demand';
const DEMAND_AUTH_TOKEN = process.env.DEMAND_AUTH_TOKEN ?? 'local-demand-token';
const OWNCAST_URL = process.env.OWNCAST_URL ?? 'http://localhost:8585';
const OWNCAST_ADMIN = process.env.OWNCAST_ADMIN ?? 'admin:abc123';
const REPORT_PATH = process.env.REPORT_PATH ?? '/tmp/livelier-content-render-demo.md';
const INSTANCE_URL = 'http://owncast-test:8080';

// Real, widely-replicated profiles for the resolves-to-@name cases; verified
// against public relays at runtime, with a fallback note if unreachable.
const KNOWN_NPUB_CANDIDATES = [
  'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', // jack
  'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', // fiatjaf
];
const PUBLIC_READ_RELAYS = ['wss://relay.primal.net', 'wss://nos.lol'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(relayUrl, filter, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const events = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(events);
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'demo', filter])));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'EVENT' && msg[1] === 'demo') events.push(msg[2]);
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

function openViewerSub(relayUrl, aTag) {
  const ws = new WebSocket(relayUrl);
  ws.on('open', () =>
    ws.send(JSON.stringify(['REQ', 'viewer', { kinds: [1311], '#a': [aTag], limit: 200 }]))
  );
  ws.on('message', () => {});
  return { ws, close: () => ws.close() };
}

async function fetchDemand() {
  const res = await fetch(DEMAND_URL, {
    headers: { Authorization: `Bearer ${DEMAND_AUTH_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`demand HTTP ${res.status}`);
  return (await res.json()).demand ?? [];
}

async function owncastAdminMessages() {
  const res = await fetch(`${OWNCAST_URL}/api/admin/chat/messages`, {
    headers: { Authorization: `Basic ${Buffer.from(OWNCAST_ADMIN).toString('base64')}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`owncast admin messages HTTP ${res.status}`);
  return res.json();
}

/** Derive the manual row's identity with the repo's own derivation code. */
function deriveInstanceIdentity() {
  const script = `
    import { instanceSigner, dTagFor } from './src/core/identity';
    const signer = instanceSigner('${INSTANCE_URL}', 'local-dev-secret-change-me', 'owncast');
    console.log(JSON.stringify({ pubkey: signer.getPublicKey(), dTag: dTagFor('${INSTANCE_URL}', 'oc') }));
  `;
  const out = execSync(`npx ts-node -P tsconfig.json -e "${script.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  });
  const lastLine = out.trim().split('\n').at(-1);
  return JSON.parse(lastLine);
}

async function seedRow(identity) {
  const client = new pg.Client({ connectionString: BRIDGES_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO bridge_instances
         (url, source, origin, pubkey, d_tag, name, hls_url, status, discovery_enabled, chat_enabled)
       VALUES ($1, 'owncast', 'manual', $2, $3, 'Local Test Stream', $4, 'ended', true, true)
       ON CONFLICT (url) DO UPDATE SET
         pubkey = EXCLUDED.pubkey, d_tag = EXCLUDED.d_tag, hls_url = EXCLUDED.hls_url,
         discovery_enabled = true, chat_enabled = true`,
      [INSTANCE_URL, identity.pubkey, identity.dTag, `${INSTANCE_URL}/hls/stream.m3u8`]
    );
  } finally {
    await client.end();
  }
}

async function pickKnownNpub() {
  for (const npub of KNOWN_NPUB_CANDIDATES) {
    const { data: pubkey } = nip19.decode(npub);
    for (const relay of PUBLIC_READ_RELAYS) {
      try {
        const profiles = await query(relay, { kinds: [0], authors: [pubkey], limit: 1 }, 6000);
        if (profiles.length > 0) {
          const name = JSON.parse(profiles[0].content).name ?? '(unnamed)';
          return { npub, pubkey, expectedName: name };
        }
      } catch {
        // Relay unreachable — try the next one.
      }
    }
  }
  return null;
}

async function main() {
  console.log('Livelier content-render demo\n');

  // ---- Stack preflight -----------------------------------------------------
  const status = await fetch(`${OWNCAST_URL}/api/status`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json())
    .catch(() => null);
  if (!status) throw new Error(`Owncast unreachable at ${OWNCAST_URL} — is the stack up?`);
  console.log(`Owncast up (online=${status.online}). Deriving identity + seeding row…`);
  if (!status.online) {
    throw new Error('Owncast is not receiving a stream — start the ffmpeg feed first.');
  }

  const identity = deriveInstanceIdentity();
  await seedRow(identity);
  console.log(`Row seeded: pubkey=${identity.pubkey.slice(0, 8)}… d=${identity.dTag}`);

  // ---- Wait for the bridge to publish the room's 30311 ---------------------
  process.stdout.write('Waiting for the 30311 (one poll cycle, up to 4 min)');
  let room = null;
  let bridgePubkey = null;
  for (let i = 0; i < 48 && !room; i++) {
    const events = await query(SW2_URL, { kinds: [30311], '#p': [identity.pubkey] }, 4000);
    room = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    if (!room) {
      process.stdout.write('.');
      await sleep(5000);
    }
  }
  console.log('');
  if (!room) throw new Error('No 30311 for the seeded room appeared on SW2.');
  bridgePubkey = room.pubkey;
  const dTag = room.tags.find((t) => t[0] === 'd')[1];
  const aTag = `30311:${bridgePubkey}:${dTag}`;
  console.log(`Room live: ${aTag}`);

  // ---- Viewer identity (named, so the sender column reads clearly) ---------
  const viewerSk = generateSecretKey();
  const viewerPubkey = getPublicKey(viewerSk);
  const kind0 = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name: 'Token Demo Viewer' }),
    },
    viewerSk
  );
  await publish(CHAT_RELAY_URL, kind0);

  // ---- Demand: the viewer subscription triggers the bridge's chat join -----
  const viewerSub = openViewerSub(CHAT_RELAY_URL, aTag);
  process.stdout.write('Waiting for demand + bridge chat join (up to 90s)');
  let demandSeen = false;
  for (let i = 0; i < 18; i++) {
    const demand = await fetchDemand().catch(() => []);
    if (demand.some((d) => JSON.stringify(d).includes(dTag))) {
      demandSeen = true;
      break;
    }
    process.stdout.write('.');
    await sleep(5000);
  }
  console.log('');
  if (!demandSeen) throw new Error('Viewer demand never registered on /demand.');
  // Give the bridge's demand poll + room reconcile time to join Owncast chat.
  await sleep(45000);

  // ---- The message set -----------------------------------------------------
  const known = await pickKnownNpub();
  if (known) {
    console.log(`Known profile for mention cases: ${known.expectedName} (${known.npub.slice(0, 12)}…)`);
  } else {
    console.log('WARNING: no public relay reachable — mention cases will show the abridged fallback.');
  }
  const knownNpub = known?.npub ?? nip19.npubEncode(getPublicKey(generateSecretKey()));
  const knownNprofile = known
    ? nip19.nprofileEncode({ pubkey: known.pubkey })
    : nip19.nprofileEncode({ pubkey: getPublicKey(generateSecretKey()) });
  const unknownNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const noteRef = nip19.noteEncode('a'.repeat(64));
  const neventRef = nip19.neventEncode({ id: 'b'.repeat(64) });
  const naddrRef = nip19.naddrEncode({ kind: 30311, pubkey: bridgePubkey, identifier: dTag });
  const emojiTag = ['emoji', 'blob-dance', 'https://media.tenor.com/images/blob-dance.gif'];

  const cases = [
    { id: 'T01', label: 'plain text (control)', content: 'T01 plain text — hello from nostr' },
    { id: 'T02', label: 'npub mention (known profile)', content: `T02 mention nostr:${knownNpub}` },
    { id: 'T03', label: 'nprofile mention (known profile)', content: `T03 mention ${knownNprofile}` },
    { id: 'T04', label: 'npub mention (unknown profile)', content: `T04 mention nostr:${unknownNpub}` },
    { id: 'T05', label: 'note reference', content: `T05 see nostr:${noteRef}` },
    { id: 'T06', label: 'nevent reference', content: `T06 see nostr:${neventRef}` },
    { id: 'T07', label: 'naddr reference (this room)', content: `T07 see nostr:${naddrRef}` },
    { id: 'T08', label: 'plain URL', content: 'T08 watch https://livelier.live/?demo=1 now' },
    { id: 'T09', label: 'custom emoji (NIP-30)', content: 'T09 gm :blob-dance:', tags: [emojiTag] },
    {
      id: 'T10',
      label: 'mixed content',
      content: `T10 hi nostr:${knownNpub} — see https://livelier.live and nostr:${noteRef} :blob-dance:`,
      tags: [emojiTag],
    },
    {
      id: 'T11',
      label: 'instance-asset emoji URL (inline img round-trip)',
      // The tagged URL IS the local instance's own emoji asset (the shape a
      // Nostr reply quoting a bridged emoji carries), so the adapter renders
      // a real inline <img>. A foreign URL — even with a matching name —
      // stays a link (T09/T10 prove that path).
      content: 'T11 hi :ablobattention:',
      tags: [['emoji', 'ablobattention', `${INSTANCE_URL}/img/emoji/blob/ablobattention.gif`]],
    },
  ];

  console.log(`Publishing ${cases.length} viewer 1311s…`);
  for (const c of cases) {
    const event = finalizeEvent(
      {
        kind: 1311,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', aTag, CHAT_RELAY_URL.replace('localhost:7450', 'ephemeral-relay:3335'), 'root'], ...(c.tags ?? [])],
        content: c.content,
      },
      viewerSk
    );
    const { accepted, message } = await publish(CHAT_RELAY_URL, event);
    console.log(`  ${c.id} ${accepted ? 'accepted' : `REJECTED: ${message}`}`);
    await sleep(1500); // stay clear of the sender pool's per-sender pacing
  }

  // Profile resolution for mentions can take a few seconds per unique pubkey.
  console.log('Waiting 30s for bridge delivery…');
  await sleep(30000);

  // ---- S→N: an Owncast emoji message must bridge with a NIP-30 tag ---------
  console.log('S→N: posting an instance-emoji message into Owncast chat…');
  const ocReg = await fetch(`${OWNCAST_URL}/api/chat/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Emoji Fan' }),
  }).then((r) => r.json());
  const ocWs = new WebSocket(`${OWNCAST_URL.replace(/^http/, 'ws')}/ws?accessToken=${ocReg.accessToken}`);
  await new Promise((res, rej) => {
    ocWs.on('open', res);
    ocWs.on('error', rej);
  });
  ocWs.send(
    JSON.stringify({
      type: 'CHAT',
      body: 'S2N emoji test <img src="/img/emoji/blob/ablobattention.gif" class="emoji" alt=":ablobattention:">',
    })
  );
  await sleep(500);
  ocWs.close();

  let bridged1311 = null;
  for (let i = 0; i < 12 && !bridged1311; i++) {
    await sleep(5000);
    const events = await query(CHAT_RELAY_URL, { kinds: [1311], '#a': [aTag], limit: 100 });
    bridged1311 = events.find((e) => e.content.includes('S2N emoji test')) ?? null;
  }
  const s2nEmojiTag = bridged1311?.tags.find((t) => t[0] === 'emoji') ?? null;
  if (bridged1311) {
    console.log(`S→N bridged 1311 content: ${JSON.stringify(bridged1311.content)}`);
    console.log(`S→N NIP-30 emoji tag: ${JSON.stringify(s2nEmojiTag)}`);
  } else {
    console.log('S→N: bridged 1311 did not appear on the chat relay.');
  }

  // ---- Read back what Owncast shows ----------------------------------------
  const messages = await owncastAdminMessages();
  const rows = cases.map((c) => {
    const delivered = messages.find((m) => typeof m.body === 'string' && m.body.includes(c.id));
    return {
      ...c,
      delivered: Boolean(delivered),
      owncastBody: delivered ? delivered.body : '(not delivered)',
      sender: delivered?.user?.displayName ?? '',
    };
  });

  const lines = [
    '# Content-render demo — Nostr 1311 → Owncast chat',
    '',
    `Stack: local compose. Room \`${aTag}\`.`,
    `Owncast chat UI: ${OWNCAST_URL} (messages left in place for review).`,
    '',
    '| # | Case | Nostr content (input) | Owncast body (output) | Delivered |',
    '|---|------|----------------------|----------------------|-----------|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.label} | \`${r.content.replace(/\|/g, '\\|')}\` | \`${String(r.owncastBody).replace(/\|/g, '\\|')}\` | ${r.delivered ? '✅' : '❌'} |`
    ),
    '',
    `Sender shown in Owncast: ${rows.find((r) => r.sender)?.sender ?? '(none delivered)'}`,
    known
      ? `Known-profile mention target: ${known.expectedName}`
      : 'NOTE: public relays unreachable during the run — mention cases show the abridged fallback.',
    '',
    '## S→N: Owncast emoji → NIP-30 tagged 1311',
    '',
    bridged1311
      ? [
          `Owncast input: instance emoji \`:ablobattention:\` (img, relative src)`,
          `Bridged 1311 content: \`${bridged1311.content}\``,
          `NIP-30 emoji tag: \`${JSON.stringify(s2nEmojiTag)}\``,
        ].join('\n')
      : '❌ bridged 1311 did not appear on the chat relay.',
    '',
  ];
  writeFileSync(REPORT_PATH, lines.join('\n'));

  console.log('\nResults:');
  for (const r of rows) {
    console.log(`  ${r.delivered ? '✅' : '❌'} ${r.id} ${r.label}`);
    console.log(`     in : ${r.content}`);
    console.log(`     out: ${r.owncastBody}`);
  }
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(`View in Owncast: ${OWNCAST_URL} (chat panel)`);

  viewerSub.close();
  const failed = rows.filter((r) => !r.delivered).length + (bridged1311 && s2nEmojiTag ? 0 : 1);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exit(1);
});
