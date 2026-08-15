// Load env for local dev; container/Railway env overrides these.
import 'dotenv/config';

// Configure WebSocket polyfill for Node.js BEFORE importing anything that pulls
// in nostr-tools.
import WebSocket from 'ws';
// @ts-ignore - assign Node ws as the global used by nostr-tools SimplePool
global.WebSocket = WebSocket;

import { createLogger } from './logger';
import { loadConfig } from './config';
import { nostrClient } from './core/nostr/client';
import { networkChatReadRelays, profileWriteRelays } from './core/relays';
import { InstanceStore } from './core/instance-store';
import { LiveEventPublisher } from './core/nostr/live-event.publisher';
import { DiscoveryBridgeService } from './core/discovery/discovery-bridge.service';
import { ChatBridgeService } from './core/chat/chat-bridge.service';
import { ClientServiceGateway } from './core/nostr/nostr-gateway';
import { DemandClient } from './core/nostr/demand.client';
import { bridgeSignerFrom } from './core/identity';
import { OwncastAdapter } from './sources/owncast/adapter';

const log = createLogger('BridgesWorker');

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection');
});

interface RunningService {
  stop(): void;
}

/**
 * Composition root. One block per enabled source network: build its adapter,
 * then start its discovery engine and (if gated on) its chat service. Adding
 * a network means adding an adapter + a block here — core stays untouched.
 */
async function main(): Promise<void> {
  const { core, owncast } = loadConfig();
  // Stamp every signed event with the bridge's client tag.
  nostrClient.setClientName(core.bridgeName);
  // Effective relay sets for this boot. Reads are unconstrained (profile
  // lookups use the shared stack's full coverage); WRITES are the gated part.
  const profileRelays = profileWriteRelays(core);
  const chatNetworkRelays = networkChatReadRelays(core);
  log.info(
    {
      networkProfilePublishEnabled: core.networkProfilePublishEnabled,
      networkChatReadEnabled: core.networkChatReadEnabled,
      profileWriteRelays: profileRelays,
      networkChatReadRelays: chatNetworkRelays,
    },
    'network relay posture'
  );
  if (core.networkProfilePublishEnabled) {
    log.warn(
      { profileWriteRelays: profileRelays },
      'NETWORK PROFILE PUBLISH ENABLED — bridged identities fan out to network ' +
        'profile relays. Only ONE environment may ever hold this flag: every ' +
        'environment derives different keys for the same channels, and a second ' +
        'publisher mints duplicate identities the network keeps forever.'
    );
  }
  const store = new InstanceStore(core.databaseUrl);
  await store.init();
  const publisher = new LiveEventPublisher();
  const bridgeSigner = bridgeSignerFrom(core);
  const running: RunningService[] = [];

  // --- Owncast ---
  if (owncast.enabled) {
    const adapter = new OwncastAdapter({
      directoryUrl: owncast.directoryUrl,
      hlsTimeoutMs: owncast.hlsTimeoutMs,
      bridgeName: core.bridgeName,
      log: createLogger('OwncastChat'),
    });

    if (owncast.discoveryEnabled) {
      // The bridge identity's own kind-0 is the operator's to curate, published
      // out-of-band with the bridge nsec. The bridge never writes it: kind-0 is
      // replaceable, so an automated publish would clobber the curated profile.
      const discovery = new DiscoveryBridgeService(
        {
          bridgeKeySecret: core.bridgeKeySecret,
          eventRelayUrl: core.eventRelayUrl,
          chatRelayUrl: core.chatRelayUrl,
          profileWriteRelays: profileRelays,
          pollIntervalMs: owncast.pollIntervalMs,
          republishIntervalMs: owncast.republishIntervalMs,
          snapshotIntervalMs: owncast.snapshotIntervalMs,
          maxConsecutiveFailures: owncast.maxConsecutiveFailures,
          defaultDiscoveryEnabled: owncast.defaultDiscoveryEnabled,
          defaultChatEnabled: owncast.defaultChatEnabled,
        },
        adapter,
        store,
        publisher,
        bridgeSigner,
        createLogger('OwncastDiscovery')
      );
      await discovery.start();
      running.push(discovery);
    } else {
      log.warn('owncast discovery disabled via OWNCAST_DISCOVERY_ENABLED');
    }

    if (owncast.chatToNostr || owncast.chatFromNostr) {
      const chat = new ChatBridgeService(
        {
          bridgeName: core.bridgeName,
          chatRelayUrl: core.chatRelayUrl,
          profileWriteRelays: profileRelays,
          networkChatReadRelays: chatNetworkRelays,
          chatToNostr: owncast.chatToNostr,
          chatFromNostr: owncast.chatFromNostr,
          chatExpirationSeconds: core.chatExpirationSeconds,
          demandPollIntervalMs: core.demandPollIntervalMs,
        },
        store,
        new ClientServiceGateway(core.chatRelayUrl),
        adapter,
        bridgeSigner,
        createLogger('OwncastChatBridge'),
        core.demandUrl ? new DemandClient(core.demandUrl, core.demandAuthToken) : null
      );
      await chat.start();
      running.push(chat);
    }
  } else {
    log.warn('owncast source disabled via OWNCAST_ENABLED');
  }

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    for (const service of running) service.stop();
    void store.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err }, 'fatal: bridges worker failed to start');
  process.exit(1);
});
