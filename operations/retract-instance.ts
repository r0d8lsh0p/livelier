/**
 * Manually remove an instance's published events from the relays: NIP-09
 * kind-5 for the 30311 (by coordinate, bridge-signed) and a blank kind-0
 * replacement (instance-signed).
 *
 * Deliberately NOT automatic: setting discovery off only stops the machine;
 * whether already-published history should also disappear is a separate
 * operator decision — some opt-outs mean "stop going forward, keep what's
 * there". Refuses to run while discovery is still on (the poller would just
 * republish next cycle).
 *
 * Usage: npx ts-node -P packages/bridge/tsconfig.json operations/retract-instance.ts <url> [--confirm]
 *   Dry-run by default. Uses the same env as the worker (.env / process env):
 *   relays, DATABASE_URL, BRIDGE_KEY_SECRET / BRIDGE_NSEC.
 */
import 'dotenv/config';
import WebSocket from 'ws';
// @ts-ignore - assign Node ws as the global used by nostr-tools SimplePool
global.WebSocket = WebSocket;

import { loadConfig } from '../packages/bridge/src/config';
import { InstanceStore } from '../packages/bridge/src/core/instance-store';
import { LiveEventPublisher } from '../packages/bridge/src/core/nostr/live-event.publisher';
import { bridgeSignerFrom, instanceSigner } from '../packages/bridge/src/core/identity';
import { profileWriteRelays } from '../packages/bridge/src/core/relays';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: npx ts-node -P packages/bridge/tsconfig.json operations/retract-instance.ts <url> [--confirm]');
    process.exit(2);
  }

  const { core } = loadConfig();
  const store = new InstanceStore(core.databaseUrl);
  const row = await store.get(url);
  if (!row) {
    console.error(`No bridge_instances row for '${url}'.`);
    await store.close();
    process.exit(1);
  }
  if (row.discovery_enabled) {
    console.error('Refusing: discovery is still ON for this instance — the poller would');
    console.error('republish within a cycle. First: operations/set-discovery.mjs off.');
    await store.close();
    process.exit(1);
  }

  const profileRelays = profileWriteRelays(core);
  console.log(`Instance:      ${row.url} (${row.name})`);
  console.log(`Coordinate:    30311:<bridge>:${row.d_tag} on ${core.eventRelayUrl}`);
  console.log(`Profile:       kind-0 blanked as ${row.pubkey.slice(0, 16)}… on ${profileRelays.join(', ')}`);
  console.log('DB after:      last_published_at/profile_hash cleared, status=ended (row kept)');

  if (!confirm) {
    console.log('\nDRY RUN — nothing published. Re-run with --confirm to execute.');
    await store.close();
    return;
  }

  const publisher = new LiveEventPublisher();
  const bridgeSigner = bridgeSignerFrom(core);

  const retract = await publisher.retractLiveEvent(bridgeSigner, row.d_tag, core.eventRelayUrl);
  console.log(`kind-5 deletion: ${JSON.stringify(retract)}`);
  const blank = await publisher.blankProfile(
    instanceSigner(row.url, core.bridgeKeySecret, row.source),
    profileRelays
  );
  console.log(`kind-0 blanked:  ${JSON.stringify(blank)}`);

  const accepted = Object.values(retract).some(Boolean) && Object.values(blank).some(Boolean);
  if (!accepted) {
    console.error('A relay rejected the retraction — DB markers left in place; re-run.');
    await store.close();
    process.exit(1);
  }

  await store.update(row.url, { last_published_at: null, profile_hash: null, status: 'ended' });
  console.log('Done. DB markers cleared; row retained.');
  await store.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('retract-instance failed:', err);
  process.exit(1);
});
