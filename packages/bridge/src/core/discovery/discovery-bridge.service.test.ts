/**
 * Behaviour test for the source-agnostic discovery lifecycle. The adapter and
 * store are plain fakes; the publisher module is mocked (it would pull the
 * heavy shared client service).
 */
import type { Logger } from 'pino';
import { DiscoveryBridgeService, DiscoveryEngineConfig } from './discovery-bridge.service';
import { DiscoveredLive, DiscoveryAdapter } from './types';
import { InstanceRow } from '../types';
import { bridgeSignerFrom, profileHash } from '../identity';

jest.mock('../nostr/live-event.publisher', () => ({
  buildBridgedProfileContent: jest.fn(() => 'profile-content'),
  LiveEventPublisher: jest.fn(),
}));

const config: DiscoveryEngineConfig = {
  bridgeKeySecret: 'secret',
  eventRelayUrl: 'ws://event-relay:8080',
  chatRelayUrl: 'ws://chat-relay:8080',
  profileWriteRelays: ['ws://chat-relay:8080', 'ws://dummy-purple:8080'],
  pollIntervalMs: 60000,
  republishIntervalMs: 900000,
  snapshotIntervalMs: 3600000,
  maxConsecutiveFailures: 3,
  defaultDiscoveryEnabled: true,
  defaultChatEnabled: false,
};

const bridgeSigner = bridgeSignerFrom({ bridgeNsec: null, bridgeKeySecret: 'secret' });

const noopLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const OK = { 'ws://relay:8080': true };

const makeRow = (over: Partial<InstanceRow> = {}): InstanceRow => ({
  url: 'https://live.example',
  source: 'owncast',
  origin: 'discovered',
  pubkey: 'pk',
  d_tag: 'oc-0123456789abcdef',
  name: 'Chan',
  stream_title: 'Title',
  description: 'desc',
  image: 'https://live.example/thumbnail.jpg',
  nsfw: false,
  starts_at: new Date('2026-08-10T06:00:00Z'),
  status: 'live',
  hls_url: 'https://live.example/hls/stream.m3u8',
  last_liveness: null,
  consecutive_failures: 0,
  profile_hash: null,
  viewer_count: null,
  chat_enabled: false,
  discovery_enabled: true,
  first_seen_at: new Date('2026-08-10T06:00:00Z'),
  last_seen_at: new Date('2026-08-10T06:00:00Z'),
  last_published_at: null,
  updated_at: new Date('2026-08-10T06:00:00Z'),
  ...over,
});

const discovered: DiscoveredLive = {
  url: 'https://live.example',
  name: 'Chan',
  streamTitle: 'Title',
  description: 'desc',
  picture: 'https://live.example/logo',
  image: 'https://live.example/thumbnail.jpg',
  nsfw: false,
  startsAt: Math.floor(Date.parse('2026-08-10T06:00:00Z') / 1000),
  streamUrl: 'https://live.example/hls/stream.m3u8',
  tags: ['music'],
};

function makeAdapter() {
  return {
    sourceKey: 'owncast',
    sourceName: 'Owncast',
    dTagPrefix: 'oc',
    proxyProtocol: 'web',
    fetchLive: jest.fn(),
    checkLiveness: jest.fn(),
    // Default: no signal — viewer-count logic stays inert unless a test arms it.
    fetchViewerCount: jest.fn().mockResolvedValue(undefined),
  } satisfies DiscoveryAdapter & {
    fetchLive: jest.Mock;
    checkLiveness: jest.Mock;
    fetchViewerCount: jest.Mock;
  };
}

function makeStore(row: InstanceRow, isNew: boolean) {
  return {
    init: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    upsertSeen: jest.fn().mockResolvedValue({ row, isNew }),
    get: jest.fn().mockResolvedValue(row),
    listByStatus: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
    insertLiveSnapshot: jest.fn().mockResolvedValue(undefined),
    latestSnapshotAt: jest.fn().mockResolvedValue(null),
    listManual: jest.fn().mockResolvedValue([]),
    listChatRooms: jest.fn().mockResolvedValue([]),
  };
}

function makePublisher() {
  return {
    publishProfile: jest.fn().mockResolvedValue(OK),
    publishBridgeIdentity: jest.fn().mockResolvedValue(OK),
    publishLiveEvent: jest.fn().mockResolvedValue(OK),
  };
}

function makeEngine(
  adapter: ReturnType<typeof makeAdapter>,
  store: ReturnType<typeof makeStore>,
  publisher: ReturnType<typeof makePublisher>
) {
  return new DiscoveryBridgeService(
    config,
    adapter,
    store as never,
    publisher as never,
    bridgeSigner,
    noopLog
  );
}

describe('DiscoveryBridgeService.runCycle', () => {
  it('publishes profile + 30311 for a newly-seen live instance', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({
      live: [discovered],
      raw: [{ url: discovered.url, extraRawField: 'kept-verbatim' }],
      schemaVersion: 'v1',
    });
    adapter.checkLiveness.mockResolvedValue('live');

    const store = makeStore(makeRow(), true);
    const publisher = makePublisher();
    const engine = makeEngine(adapter, store, publisher);

    const metrics = await engine.runCycle();

    expect(metrics.directoryOk).toBe(true);
    expect(metrics.liveInDirectory).toBe(1);
    expect(metrics.hlsLive).toBe(1);
    expect(metrics.newInstances).toBe(1);
    expect(publisher.publishProfile).toHaveBeenCalledTimes(1);
    expect(publisher.publishLiveEvent).toHaveBeenCalledTimes(1);

    // Rows are stamped with the adapter's source key.
    expect(store.upsertSeen).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'owncast', url: 'https://live.example' })
    );

    // Routing: 30311s target the durable event relay; the NIP-53 relays hint
    // carries the chat relay so clients join the 1311 room in the right place.
    const liveArg = publisher.publishLiveEvent.mock.calls[0][0];
    expect(liveArg.relayUrl).toBe('ws://event-relay:8080');
    expect(liveArg.chatRelayUrl).toBe('ws://chat-relay:8080');
    expect(liveArg.proxyProtocol).toBe('web');
    // Instance profiles are signed by derived keys, which the event relay's
    // bridge-pubkey-only write whitelist rejects → they go to the configured
    // profile-write set (chat relay + network profile relays when enabled).
    expect(publisher.publishProfile.mock.calls[0][2]).toEqual([
      'ws://chat-relay:8080',
      'ws://dummy-purple:8080',
    ]);
    expect(liveArg.status).toBe('live');
    // Authorship: bridge identity signs; the instance's derived key stays host.
    expect(liveArg.hostPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(liveArg.signer.getPublicKey()).not.toBe(liveArg.hostPubkey);
    // d-tag carries the adapter prefix and stays under 30 chars — longer
    // coordinates break #a queries on nostrlib relays.
    expect(liveArg.dTag).toMatch(/^oc-[0-9a-f]{16}$/);
    expect(store.update).toHaveBeenCalledWith(
      'https://live.example',
      expect.objectContaining({ status: 'live', last_liveness: 'live' })
    );
  });

  it('republishes on the heartbeat, and quiet cycles do not reset the heartbeat clock', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');

    // Published 2 minutes ago: within the interval → no publish, and the
    // update must NOT touch last_published_at (bumping it every cycle would
    // keep the republish heartbeat forever due and stale events never renew).
    const recent = makeRow({ status: 'live', last_published_at: new Date(Date.now() - 2 * 60_000) });
    const quietStore = makeStore(recent, false);
    const quietPublisher = makePublisher();
    await makeEngine(adapter, quietStore, quietPublisher).runCycle();
    expect(quietPublisher.publishLiveEvent).not.toHaveBeenCalled();
    for (const call of quietStore.update.mock.calls) {
      expect(call[1]).not.toHaveProperty('last_published_at');
    }

    // Published 20 minutes ago: past the 15-minute interval → heartbeat
    // republish fires and the clock resets.
    const stale = makeRow({ status: 'live', last_published_at: new Date(Date.now() - 20 * 60_000) });
    const dueStore = makeStore(stale, false);
    const duePublisher = makePublisher();
    await makeEngine(adapter, dueStore, duePublisher).runCycle();
    expect(duePublisher.publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(dueStore.update).toHaveBeenCalledWith(
      'https://live.example',
      expect.objectContaining({ last_published_at: expect.any(Date) })
    );
  });

  it('bridges NSFW instances, carrying the flag through to the publisher (no filtering)', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({
      live: [{ ...discovered, nsfw: true }],
      raw: [{ ...discovered, nsfw: true }],
      schemaVersion: 'v1',
    });
    adapter.checkLiveness.mockResolvedValue('live');
    const store = makeStore(makeRow({ nsfw: true }), true);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();
    expect(publisher.publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ nsfw: true })
    );
  });

  it('keeps last-known state on live-set fetch failure (and takes no snapshot)', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockRejectedValue(new Error('down'));
    const store = makeStore(makeRow(), false);
    const publisher = makePublisher();

    const metrics = await makeEngine(adapter, store, publisher).runCycle();
    expect(metrics.directoryOk).toBe(false);
    expect(store.upsertSeen).not.toHaveBeenCalled();
    expect(store.listByStatus).not.toHaveBeenCalled();
    expect(store.insertLiveSnapshot).not.toHaveBeenCalled();
  });

  it('captures a source-stamped raw snapshot when due, then not again within the interval', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({
      live: [discovered],
      raw: [{ url: discovered.url, extraRawField: 'kept-verbatim' }],
      schemaVersion: 'v1',
    });
    adapter.checkLiveness.mockResolvedValue('live');
    const store = makeStore(makeRow(), false);
    const publisher = makePublisher();
    const engine = makeEngine(adapter, store, publisher);

    const first = await engine.runCycle();
    expect(first.snapshotTaken).toBe(true);
    expect(store.insertLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(store.insertLiveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'owncast',
        directoryLiveCount: 1,
        bridgedLiveCount: 1,
        hlsLive: 1,
        schemaVersion: 'v1',
        raw: [expect.objectContaining({ extraRawField: 'kept-verbatim' })],
      })
    );

    const second = await engine.runCycle();
    expect(second.snapshotTaken).toBe(false);
    expect(store.insertLiveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('marks a disappeared instance ended after max consecutive failures, scoped to its source', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [], raw: [], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('ended');
    const row = makeRow({ consecutive_failures: 2 }); // one more failure hits the max (3)
    const store = makeStore(row, false);
    store.listByStatus.mockResolvedValue([row]);
    const publisher = makePublisher();

    const metrics = await makeEngine(adapter, store, publisher).runCycle();
    expect(metrics.endedThisCycle).toBe(1);
    // Reconciliation only sees this adapter's rows.
    expect(store.listByStatus).toHaveBeenCalledWith('live', 'owncast');
    expect(store.listManual).toHaveBeenCalledWith('owncast');
    expect(publisher.publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ended',
        relayUrl: 'ws://event-relay:8080',
        dTag: 'oc-0123456789abcdef', // reuses the row's stored d-tag
        hostPubkey: 'pk',
      })
    );
    expect(store.update).toHaveBeenCalledWith(
      'https://live.example',
      expect.objectContaining({ status: 'ended' })
    );
  });

  it('stamps the default posture onto new rows at insert', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    const store = makeStore(makeRow(), true);

    await makeEngine(adapter, store, makePublisher()).runCycle();
    expect(store.upsertSeen).toHaveBeenCalledWith(
      expect.objectContaining({ discovery_enabled: true, chat_enabled: false })
    );
  });

  it('opted-out instance: metadata refreshes but no probe and nothing reaches the relays', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    const optedOut = makeRow({ discovery_enabled: false });
    const store = makeStore(optedOut, false);
    const publisher = makePublisher();

    const metrics = await makeEngine(adapter, store, publisher).runCycle();

    expect(metrics.disabledSkipped).toBe(1);
    expect(store.upsertSeen).toHaveBeenCalledTimes(1); // DB still tracks it
    expect(adapter.checkLiveness).not.toHaveBeenCalled(); // no contact
    expect(publisher.publishProfile).not.toHaveBeenCalled();
    expect(publisher.publishLiveEvent).not.toHaveBeenCalled();
  });

  it('viewer-count change republishes immediately with current_participants and restarts the heartbeat', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    adapter.fetchViewerCount = jest.fn().mockResolvedValue(7);
    // Heartbeat NOT due, but the count moved 4 → 7.
    const seen = makeRow({ viewer_count: 4, last_published_at: new Date() });
    const store = makeStore(seen, false);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();

    expect(publisher.publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publisher.publishLiveEvent.mock.calls[0][0].currentParticipants).toBe(7);
    // The publish restarts the heartbeat clock and records the published count.
    expect(store.update).toHaveBeenCalledWith(
      seen.url,
      expect.objectContaining({ last_published_at: expect.any(Date), viewer_count: 7 })
    );
  });

  it('steady viewer count between heartbeats stays quiet; a poll error is no signal', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    const seen = makeRow({
      viewer_count: 4,
      last_published_at: new Date(),
      profile_hash: profileHash('profile-content'),
    });
    const publisher = makePublisher();

    // Unchanged count → no publish.
    adapter.fetchViewerCount = jest.fn().mockResolvedValue(4);
    await makeEngine(adapter, makeStore(seen, false), publisher).runCycle();
    expect(publisher.publishLiveEvent).not.toHaveBeenCalled();

    // Poll error (undefined) → no signal, no publish, count untouched.
    adapter.fetchViewerCount = jest.fn().mockResolvedValue(undefined);
    const store = makeStore(seen, false);
    await makeEngine(adapter, store, publisher).runCycle();
    expect(publisher.publishLiveEvent).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith(
      seen.url,
      expect.not.objectContaining({ viewer_count: expect.anything() })
    );
  });

  it('a source that hides its count publishes without the tag when it goes hidden', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [discovered], raw: [discovered], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    adapter.fetchViewerCount = jest.fn().mockResolvedValue(null); // hidden
    const seen = makeRow({ viewer_count: 4, last_published_at: new Date() });
    const store = makeStore(seen, false);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();

    expect(publisher.publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publisher.publishLiveEvent.mock.calls[0][0].currentParticipants).toBeUndefined();
    expect(store.update).toHaveBeenCalledWith(
      seen.url,
      expect.objectContaining({ viewer_count: null })
    );
  });

  it('manual live row publishes a host kind-0 from stored metadata, hash-gated', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [], raw: [], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    const manual = makeRow({ origin: 'manual', profile_hash: null, last_published_at: null });
    const store = makeStore(manual, false);
    store.listManual.mockResolvedValue([manual]);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();

    expect(publisher.publishProfile).toHaveBeenCalledTimes(1);
    const [signer, profile, relays] = publisher.publishProfile.mock.calls[0];
    expect(signer.getPublicKey()).not.toBe(bridgeSigner.getPublicKey());
    expect(profile).toEqual({
      name: manual.name,
      description: manual.description,
      picture: manual.image,
      website: manual.url,
      sourceName: 'Owncast',
    });
    expect(relays).toEqual(config.profileWriteRelays);
    expect(store.update).toHaveBeenCalledWith(
      manual.url,
      expect.objectContaining({ profile_hash: expect.any(String) })
    );
    expect(publisher.publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it('manual live row skips the kind-0 when the profile hash is unchanged', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [], raw: [], schemaVersion: 'v1' });
    adapter.checkLiveness.mockResolvedValue('live');
    // The publisher module is mocked to build constant content, so the
    // matching hash is the hash of that constant.
    const manual = makeRow({
      origin: 'manual',
      profile_hash: profileHash('profile-content'),
      last_published_at: null,
    });
    const store = makeStore(manual, false);
    store.listManual.mockResolvedValue([manual]);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();

    expect(publisher.publishProfile).not.toHaveBeenCalled();
    expect(publisher.publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it('never probes or tears down an opted-out row — the flag stops the machine, nothing more', async () => {
    const adapter = makeAdapter();
    adapter.fetchLive.mockResolvedValue({ live: [], raw: [], schemaVersion: 'v1' });
    // Published events exist; they must be left alone (retraction is a
    // separate manual operator action, never an engine behavior).
    const optedOut = makeRow({
      discovery_enabled: false,
      last_published_at: new Date(),
      profile_hash: 'abc',
    });
    const store = makeStore(optedOut, false);
    store.listByStatus.mockResolvedValue([optedOut]);
    const publisher = makePublisher();

    await makeEngine(adapter, store, publisher).runCycle();
    expect(adapter.checkLiveness).not.toHaveBeenCalled();
    expect(publisher.publishLiveEvent).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled(); // markers untouched
  });
});
