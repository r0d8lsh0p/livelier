/**
 * Behaviour tests for the source-agnostic chat bridge with all boundaries
 * faked: the store, Nostr gateway, and chat adapter. Focus: room lifecycle,
 * both relay directions, and the 3-layer dedup. Source-side mechanics (echo
 * filtering, wire-format conversion) are adapter concerns, tested there.
 */
import type { Logger } from 'pino';
import { nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { ChatBridgeService, ChatServiceConfig } from './chat-bridge.service';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
import { deriveBridgeIdentityKey } from '../../../../shared/src/nostr/bridge-key';
import profileService from '../../../../shared/src/nostr/services/profile.service';
import { InstanceRow } from '../types';

// The content pipeline resolves embedded mentions through the shared profile
// service (a separate path from the gateway's sender-name lookup); stub it so
// the suite stays hermetic.
jest.mock('../../../../shared/src/nostr/services/profile.service', () => ({
  __esModule: true,
  default: { getProfile: jest.fn().mockResolvedValue(null) },
}));

const config: ChatServiceConfig = {
  bridgeName: 'Livelier',
  chatRelayUrl: 'ws://relay:8080',
  profileWriteRelays: ['ws://relay:8080'],
  networkChatReadRelays: [],
  chatToNostr: true,
  chatFromNostr: true,
  chatExpirationSeconds: 10_800,
  demandPollIntervalMs: 10_000,
};

const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
const bridgeSigner = new DerivedKeySigner(deriveBridgeIdentityKey('secret'));

const room = (over: Partial<InstanceRow> = {}): InstanceRow =>
  ({
    url: 'http://owncast-test:8080',
    source: 'owncast',
    origin: 'manual',
    pubkey: 'a'.repeat(64),
    d_tag: 'owncast-test-12345678',
    name: 'Local Test',
    stream_title: 'Test stream',
    description: '',
    image: '',
    nsfw: false,
    starts_at: new Date(),
    status: 'live',
    hls_url: 'http://owncast-test:8080/hls/stream.m3u8',
    last_liveness: 'live',
    consecutive_failures: 0,
    profile_hash: null,
    chat_enabled: true,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    last_published_at: new Date(),
    updated_at: new Date(),
    ...over,
  }) as InstanceRow;

function makeDeps(rows: InstanceRow[]) {
  const store = { listChatRooms: jest.fn().mockResolvedValue(rows) };
  const gateway = {
    publish: jest.fn().mockResolvedValue(undefined),
    broadcast: jest.fn().mockResolvedValue(undefined),
    // A fresh handle per call, whose close() re-enters onclose synchronously
    // — which is what the real client does (Subscription.close() invokes
    // onclose before returning). A shared handle would hide both the
    // re-entrancy and any failure to close the old subscription.
    subscribe1311: jest.fn().mockImplementation((_onevent, onclose) => {
      const handle = { close: jest.fn(() => onclose?.(['closed by caller'])) };
      return handle;
    }),
    subscribeNetworkChat: jest.fn().mockImplementation((_relays, _onevent, onclose) => {
      const handle = { close: jest.fn(() => onclose?.(['closed by caller'])) };
      return handle;
    }),
    fetchProfileName: jest.fn().mockResolvedValue('NostrAlice'),
  };
  const adapter = {
    sourceKey: 'owncast',
    sourceName: 'Owncast',
    openListener: jest.fn().mockResolvedValue({ stop: jest.fn() }),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    closeRoom: jest.fn(),
    closeAll: jest.fn(),
  };
  return { store, gateway, adapter };
}

function makeService(
  deps: ReturnType<typeof makeDeps>,
  demand: { fetchDemandedATags: jest.Mock } | null = null,
  configOverride: Partial<ChatServiceConfig> = {}
) {
  return new ChatBridgeService(
    { ...config, ...configOverride },
    deps.store as never,
    deps.gateway as never,
    deps.adapter as never,
    bridgeSigner,
    noopLog,
    demand
  );
}

/** Peek at a room's private listener state. */
function listenerOf(svc: ChatBridgeService, url: string): unknown {
  const rooms = (svc as never as { rooms: Map<string, { listener: unknown }> }).rooms;
  return rooms.get(url)?.listener ?? null;
}

function roomOf(svc: ChatBridgeService, url: string): never {
  return (svc as never as { rooms: Map<string, unknown> }).rooms.get(url) as never;
}

/** Fire one heartbeat. Both of these run on their own timers in the service. */
function beat(svc: ChatBridgeService): void {
  (svc as never as { logHeartbeat: () => void }).logHeartbeat();
}
function healthCheck(svc: ChatBridgeService): void {
  (svc as never as { checkSubscriptionHealth: () => void }).checkSubscriptionHealth();
}

/** Backdate the last received event, so the health check sees silence. */
function silentFor(svc: ChatBridgeService, ms: number): void {
  const s = svc as never as { lastEventTime: number };
  s.lastEventTime = Date.now() - ms;
}

const nostrEvent = (over: Partial<Event> = {}): Event =>
  ({
    id: 'e'.repeat(64),
    pubkey: 'b'.repeat(64),
    kind: 1311,
    content: 'hi from nostr',
    created_at: 1700000000,
    sig: 's'.repeat(128),
    tags: [['a', `30311:${bridgeSigner.getPublicKey()}:owncast-test-12345678`, '', 'root']],
    ...over,
  }) as Event;

describe('ChatBridgeService', () => {
  afterEach(() => jest.clearAllMocks());

  it('opens rooms from the source-scoped allowlist and the unscoped 1311 firehose', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    expect(deps.store.listChatRooms).toHaveBeenCalledWith('owncast');
    expect(deps.gateway.subscribe1311).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function)
    );
    svc.stop();
    expect(deps.adapter.closeAll).toHaveBeenCalled();
  });

  it('tears down rooms that leave the allowlist', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    deps.store.listChatRooms.mockResolvedValue([]);
    await svc.refreshRooms();
    expect(deps.adapter.closeRoom).toHaveBeenCalledWith('http://owncast-test:8080');
    svc.stop();
  });

  it('keeps one firehose subscription open across room changes (no churn)', async () => {
    const deps = makeDeps([]);
    const close = jest.fn();
    deps.gateway.subscribe1311.mockReturnValue({ close });
    const svc = makeService(deps);

    // Opens even with zero rooms, then survives rooms appearing and vanishing.
    await svc.refreshRooms();
    deps.store.listChatRooms.mockResolvedValue([room()]);
    await svc.refreshRooms();
    deps.store.listChatRooms.mockResolvedValue([]);
    await svc.refreshRooms();

    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    svc.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('S→N: publishes chatter kind-0, 10002, and a "-"-tagged 1311 to the room a-tag', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleSourceChat(roomOf(svc, 'http://owncast-test:8080'), {
      userId: 'oc-user-1',
      displayName: 'OwncastBob',
      text: 'hello nostr',
    });

    // Profile-class events (kind 0 + 10002) broadcast to the profile-write
    // set; the '-'-tagged 1311 goes through the authed pinned publish.
    const broadcastKinds = deps.gateway.broadcast.mock.calls.map((c: unknown[]) => c[1]);
    expect(broadcastKinds).toEqual([0, 10002]);
    expect(deps.gateway.broadcast.mock.calls[0][4]).toEqual(['ws://relay:8080']);
    const [chatCall] = deps.gateway.publish.mock.calls;
    expect(chatCall[1]).toBe(1311);
    expect(chatCall[2]).toBe('hello nostr');
    expect(chatCall[3]).toContainEqual(['-']); // NIP-70 protected
    expect(chatCall[3]).toContainEqual([
      'a',
      `30311:${bridgeSigner.getPublicKey()}:owncast-test-12345678`,
      'ws://relay:8080',
      'root',
    ]);
    // Chatter profile copy carries the source's name.
    const profileCall = deps.gateway.broadcast.mock.calls[0];
    expect(profileCall[2]).toContain('(Owncast)');
    // NIP-40: expires chatExpirationSeconds from now (within test tolerance).
    const expTag = (chatCall[3] as string[][]).find((t) => t[0] === 'expiration');
    expect(expTag).toBeDefined();
    const expected = Math.floor(Date.now() / 1000) + config.chatExpirationSeconds;
    expect(Math.abs(Number(expTag?.[1]) - expected)).toBeLessThanOrEqual(5);
    svc.stop();
  });

  it('S→N: carries the source message custom emoji as NIP-30 tags', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleSourceChat(roomOf(svc, 'http://owncast-test:8080'), {
      userId: 'oc-user-1',
      displayName: 'OwncastBob',
      text: ':neocat_cry_256:',
      emojis: [
        { shortcode: 'neocat_cry_256', imageUrl: 'http://owncast-test:8080/img/emoji/neocat_cry_256.png' },
      ],
    });

    const [chatCall] = deps.gateway.publish.mock.calls;
    expect(chatCall[1]).toBe(1311);
    expect(chatCall[3]).toContainEqual([
      'emoji',
      'neocat_cry_256',
      'http://owncast-test:8080/img/emoji/neocat_cry_256.png',
    ]);
    svc.stop();
  });

  it('S→N dedup: drops empty text and repeated content (L3)', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    const activeRoom = roomOf(svc, 'http://owncast-test:8080');

    await svc.handleSourceChat(activeRoom, { userId: 'u0', displayName: 'X', text: '' });
    expect(deps.gateway.publish).not.toHaveBeenCalled();

    await svc.handleSourceChat(activeRoom, { userId: 'u1', displayName: 'Bob', text: 'same' });
    await svc.handleSourceChat(activeRoom, { userId: 'u1', displayName: 'Bob', text: 'same' });
    const chatPublishes = deps.gateway.publish.mock.calls.filter((c: unknown[]) => c[1] === 1311);
    expect(chatPublishes).toHaveLength(1);
    svc.stop();
  });

  it('S→N presence: a join publishes chatter kind-0/10002 and a "-"-tagged 10312', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleSourceJoin(roomOf(svc, 'http://owncast-test:8080'), {
      userId: 'oc-lurker-1',
      displayName: 'zen-cherry',
    });

    const broadcastKinds = deps.gateway.broadcast.mock.calls.map((c: unknown[]) => c[1]);
    expect(broadcastKinds).toEqual([0, 10002]);
    const [presenceCall] = deps.gateway.publish.mock.calls;
    expect(presenceCall[1]).toBe(10312);
    expect(presenceCall[2]).toBe('');
    expect(presenceCall[3]).toContainEqual([
      'a',
      `30311:${bridgeSigner.getPublicKey()}:owncast-test-12345678`,
      'ws://relay:8080',
      'root',
    ]);
    expect(presenceCall[3]).toContainEqual(['-']);
    const expTag = (presenceCall[3] as string[][]).find((t) => t[0] === 'expiration');
    expect(Number(expTag?.[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    svc.stop();
  });

  it('S→N presence: bridges every source join faithfully — messages never touch presence', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    const activeRoom = roomOf(svc, 'http://owncast-test:8080');
    const join = { userId: 'oc-lurker-1', displayName: 'zen-cherry' };
    const presenceCalls = () =>
      deps.gateway.publish.mock.calls.filter((c: unknown[]) => c[1] === 10312);

    // The source announced two joins, so we announce two joins. Not a rule
    // of ours — faithful bridging.
    await svc.handleSourceJoin(activeRoom, join);
    await svc.handleSourceJoin(activeRoom, join);
    expect(presenceCalls()).toHaveLength(2);

    // A message is a message: it must not manufacture presence the source
    // never announced.
    await svc.handleSourceChat(activeRoom, { ...join, text: 'still here' });
    expect(presenceCalls()).toHaveLength(2);
    svc.stop();
  });

  it('N→S: resolves the sender name and hands plain text to the adapter', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleNostrEvent(nostrEvent({ content: 'hi <all>' }));
    expect(deps.adapter.sendMessage).toHaveBeenCalledWith(
      'http://owncast-test:8080',
      'b'.repeat(64),
      'NostrAlice',
      'hi <all>', // conversion to the source wire format is the adapter's job
      [{ type: 'text', value: 'hi <all>' }]
    );
    svc.stop();
  });

  it('N→S: runs content through the shared pipeline (mention → @name)', async () => {
    const deps = makeDeps([room()]);
    (profileService.getProfile as jest.Mock).mockResolvedValue({ name: 'alice' });
    const svc = makeService(deps);
    await svc.refreshRooms();

    const npub = nip19.npubEncode('1'.repeat(64));
    await svc.handleNostrEvent(nostrEvent({ content: `hi nostr:${npub}` }));
    expect(deps.adapter.sendMessage).toHaveBeenCalledWith(
      'http://owncast-test:8080',
      'b'.repeat(64),
      'NostrAlice',
      'hi @alice',
      expect.arrayContaining([expect.objectContaining({ type: 'mention', value: '@alice' })])
    );
    svc.stop();
  });

  it('N→S: delivers in arrival order even when an earlier render resolves slower', async () => {
    const deps = makeDeps([room()]);
    // First event carries a mention whose profile lookup is slow; second is
    // plain text that renders instantly. FIFO must hold arrival order.
    (profileService.getProfile as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ name: 'slowpoke' }), 50))
    );
    const svc = makeService(deps);
    await svc.refreshRooms();

    const npub = nip19.npubEncode('2'.repeat(64));
    const first = svc.handleNostrEvent(
      nostrEvent({ id: 'f'.repeat(64), content: `question for nostr:${npub}` })
    );
    const second = svc.handleNostrEvent(nostrEvent({ content: 'the answer' }));
    await Promise.all([first, second]);

    const delivered = deps.adapter.sendMessage.mock.calls.map((c: unknown[]) => c[3]);
    expect(delivered).toEqual(['question for @slowpoke', 'the answer']);
    svc.stop();
  });

  it('N→S: a delivery still in flight when its room closes is dropped, not sent', async () => {
    const deps = makeDeps([room()]);
    // Slow name resolution keeps the delivery in flight across the teardown.
    let releaseName = () => {};
    deps.gateway.fetchProfileName.mockImplementation(
      () => new Promise((resolve) => { releaseName = () => resolve('LateAlice'); })
    );
    const svc = makeService(deps);
    await svc.refreshRooms();

    const pending = svc.handleNostrEvent(nostrEvent({ content: 'too late' }));
    // Room leaves the allowlist while the delivery awaits the name.
    deps.store.listChatRooms.mockResolvedValue([]);
    await svc.refreshRooms();
    releaseName();
    await pending;

    // Sending now would reopen a source connection the bridge just closed.
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();
    svc.stop();
  });

  it('N→S: a failed delivery drops that message but not the ones behind it', async () => {
    const deps = makeDeps([room()]);
    deps.adapter.sendMessage
      .mockRejectedValueOnce(new Error('owncast ws down'))
      .mockResolvedValue(undefined);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleNostrEvent(nostrEvent({ id: 'f'.repeat(64), content: 'lost' }));
    await svc.handleNostrEvent(nostrEvent({ content: 'delivered' }));

    const delivered = deps.adapter.sendMessage.mock.calls.map((c: unknown[]) => c[3]);
    expect(delivered).toEqual(['lost', 'delivered']);
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'owncast ws down' }),
      'nostr→source delivery failed'
    );
    svc.stop();
  });

  it('N→S: falls back to "Guest" on a missing profile, and does NOT cache the miss', async () => {
    const deps = makeDeps([room()]);
    deps.gateway.fetchProfileName.mockResolvedValue(null);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleNostrEvent(nostrEvent({ content: 'first' }));
    expect(deps.adapter.sendMessage).toHaveBeenCalledWith(
      'http://owncast-test:8080',
      'b'.repeat(64),
      'Guest',
      'first',
      [{ type: 'text', value: 'first' }]
    );

    // Profile published between messages: the next message re-queries and
    // resolves — a cached miss would pin the sender to Guest until restart.
    deps.gateway.fetchProfileName.mockResolvedValue('Quiet Owl');
    await svc.handleNostrEvent(nostrEvent({ content: 'second' }));
    expect(deps.adapter.sendMessage).toHaveBeenLastCalledWith(
      'http://owncast-test:8080',
      'b'.repeat(64),
      'Quiet Owl',
      'second',
      [{ type: 'text', value: 'second' }]
    );
    expect(deps.gateway.fetchProfileName).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('N→S dedup: skips our own client tag (L1) and bridged pubkeys (L2)', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    await svc.handleNostrEvent(
      nostrEvent({ tags: [...nostrEvent().tags, ['client', 'Livelier']] })
    );
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();

    // Create a bridged chatter, then simulate its event echoing back.
    await svc.handleSourceChat(roomOf(svc, 'http://owncast-test:8080'), {
      userId: 'u9',
      displayName: 'Bob',
      text: 'msg',
    });
    const bridgedPubkey = deps.gateway.publish.mock.calls.find(
      (c: unknown[]) => c[1] === 1311
    )?.[0] as DerivedKeySigner;
    await svc.handleNostrEvent(nostrEvent({ pubkey: bridgedPubkey.getPublicKey() }));
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();
    svc.stop();
  });

  it('connects the source listener eagerly when no demand source is wired', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    expect(deps.adapter.openListener).toHaveBeenCalledWith(
      'http://owncast-test:8080',
      expect.any(Function),
      expect.any(Function)
    );
    expect(listenerOf(svc, 'http://owncast-test:8080')).not.toBeNull();
    svc.stop();
  });

  it('demand-gated: opens the source listener only when a viewer names the room #a', async () => {
    const aTag = `30311:${bridgeSigner.getPublicKey()}:owncast-test-12345678`;
    const deps = makeDeps([room()]);
    const demand = { fetchDemandedATags: jest.fn().mockResolvedValue(new Set()) };
    const svc = makeService(deps, demand);

    await svc.refreshRooms();
    expect(listenerOf(svc, 'http://owncast-test:8080')).toBeNull();

    // No demand yet → still no listener.
    await svc.pollDemand();
    expect(listenerOf(svc, 'http://owncast-test:8080')).toBeNull();

    // A viewer subscription names our #a → listener opens.
    demand.fetchDemandedATags.mockResolvedValue(new Set([aTag]));
    await svc.pollDemand();
    expect(listenerOf(svc, 'http://owncast-test:8080')).not.toBeNull();
    svc.stop();
  });

  it('demand-gated: never tears down an established listener when demand dips', async () => {
    const aTag = `30311:${bridgeSigner.getPublicKey()}:owncast-test-12345678`;
    const deps = makeDeps([room()]);
    const demand = { fetchDemandedATags: jest.fn().mockResolvedValue(new Set([aTag])) };
    const svc = makeService(deps, demand);

    await svc.refreshRooms();
    await svc.pollDemand();
    const established = listenerOf(svc, 'http://owncast-test:8080');
    expect(established).not.toBeNull();

    demand.fetchDemandedATags.mockResolvedValue(new Set());
    await svc.pollDemand();
    expect(listenerOf(svc, 'http://owncast-test:8080')).toBe(established);
    svc.stop();
  });

  it('network watcher: one wide firehose when network relays are configured; events route internally', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, {
      networkChatReadRelays: ['ws://dummy-net:1', 'ws://dummy-net:2'],
    });

    await svc.refreshRooms();
    expect(deps.gateway.subscribeNetworkChat).toHaveBeenCalledTimes(1);
    const [relays, onNetEvent] = deps.gateway.subscribeNetworkChat.mock.calls[0];
    expect(relays).toEqual(['ws://dummy-net:1', 'ws://dummy-net:2']);

    // Room changes never churn the firehose — routing is internal.
    deps.store.listChatRooms.mockResolvedValue([]);
    await svc.refreshRooms();
    deps.store.listChatRooms.mockResolvedValue([room()]);
    await svc.refreshRooms();
    expect(deps.gateway.subscribeNetworkChat).toHaveBeenCalledTimes(1);

    // A network event for our room bridges into the source chat — the
    // livestream-relay-viewer story: correct #a, never touched our chat relay.
    await onNetEvent(nostrEvent({ content: 'from-the-wider-network' }));
    await new Promise((r) => setImmediate(r));
    expect(deps.adapter.sendMessage).toHaveBeenCalledWith(
      'http://owncast-test:8080',
      'b'.repeat(64),
      'NostrAlice',
      'from-the-wider-network',
      [{ type: 'text', value: 'from-the-wider-network' }]
    );

    // Non-1311 chat kinds ride along but are not delivered as chat text.
    deps.adapter.sendMessage.mockClear();
    await onNetEvent(nostrEvent({ kind: 1312 as never }));
    await new Promise((r) => setImmediate(r));
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();

    // Events for rooms we don't hold are dropped internally.
    deps.adapter.sendMessage.mockClear();
    await onNetEvent(nostrEvent({ tags: [['a', '30311:unknown:other', '', 'root']] }));
    await new Promise((r) => setImmediate(r));
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();
    svc.stop();
  });

  it('network watcher: inactive when the network relay set is empty (flag off)', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    expect(deps.gateway.subscribeNetworkChat).not.toHaveBeenCalled();
    svc.stop();
  });

  it('ignores events for unknown rooms', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    await svc.handleNostrEvent(
      nostrEvent({ tags: [['a', '30311:unknown:other', '', 'root']] })
    );
    expect(deps.adapter.sendMessage).not.toHaveBeenCalled();
    svc.stop();
  });

  /**
   * A dead inbound firehose raises no error and delivers no events, so it
   * reads exactly like rooms that happen to be quiet. The heartbeat is the
   * only thing that separates them.
   */
  it('heartbeat reports what the firehose received, counting events it drops', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    // One deliverable, one for a room we do not hold. Both prove the
    // subscription is alive, so both must count.
    await svc.handleNostrEvent(nostrEvent());
    await svc.handleNostrEvent(
      nostrEvent({ id: 'f'.repeat(64), tags: [['a', '30311:unknown:other', '', 'root']] })
    );

    (noopLog.info as jest.Mock).mockClear();
    beat(svc);
    expect(noopLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ rooms: 1, localSeen: 2, networkSeen: 0, delivered: 1 }),
      'chat bridge heartbeat'
    );

    // Counters are per-cycle: a quiet cycle must report zero, not carry the
    // previous cycle's traffic forward and look healthy indefinitely.
    (noopLog.info as jest.Mock).mockClear();
    beat(svc);
    expect(noopLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ localSeen: 0, networkSeen: 0, delivered: 0 }),
      'chat bridge heartbeat'
    );
    svc.stop();
  });

  /**
   * The two firehoses fail independently. Pooling their counters would let a
   * healthy network subscription mask a dead local one — which carries
   * almost all the traffic, and is exactly what died in production.
   */
  it('heartbeat counts the local and network firehoses separately', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, { networkChatReadRelays: ['wss://net.test'] });
    await svc.refreshRooms();

    // Driven through the callbacks the service actually registered, so the
    // wiring is what's under test — calling handleNostrEvent('network')
    // directly would only assert that the argument reaches the counter.
    const onLocal = deps.gateway.subscribe1311.mock.calls[0][0] as (e: Event) => void;
    const onNetwork = deps.gateway.subscribeNetworkChat.mock.calls[0][1] as (e: Event) => void;
    onNetwork(nostrEvent({ id: 'a'.repeat(64) }));
    onNetwork(nostrEvent({ id: 'b'.repeat(64) }));
    onLocal(nostrEvent({ id: 'c'.repeat(64) }));
    await Promise.resolve();

    (noopLog.info as jest.Mock).mockClear();
    beat(svc);
    expect(noopLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ localSeen: 1, networkSeen: 2 }),
      'chat bridge heartbeat'
    );
    svc.stop();
  });

  /**
   * Reported so a reader can tell a quiet room from a dead subscription:
   * every bridged source message goes to the chat relay, so a live firehose
   * reads it straight back.
   */
  it('heartbeat reports what the bridge published alongside what it saw', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    await svc.handleSourceChat(roomOf(svc, 'http://owncast-test:8080'), {
      userId: 'u1',
      displayName: 'Alice',
      text: 'hello',
    });

    (noopLog.info as jest.Mock).mockClear();
    beat(svc);
    expect(noopLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ outboundPublished: 1, localSeen: 0 }),
      'chat bridge heartbeat'
    );
    svc.stop();
  });

  /**
   * The client reports a closed REQ and stops; nothing re-opens it. Without
   * this the whole inbound direction is gone until the process restarts.
   */
  it('resubscribes when the relay closes the 1311 firehose', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);

    const onclose = deps.gateway.subscribe1311.mock.calls[0][1] as (r: string[]) => void;
    onclose(['relay connection timed out']);

    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ disconnected: 1 }),
      'relays disconnected'
    );
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 75 }),
      'disconnect threshold exceeded, triggering reconnection'
    );
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('resubscribes when the relay closes the network firehose', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, { networkChatReadRelays: ['wss://net.test'] });
    await svc.refreshRooms();
    expect(deps.gateway.subscribeNetworkChat).toHaveBeenCalledTimes(1);

    const onclose = deps.gateway.subscribeNetworkChat.mock.calls[0][2] as (r: string[]) => void;
    onclose(['relay connection closed']);
    expect(deps.gateway.subscribeNetworkChat).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  /**
   * stop() closes the subscription, which calls the same handler. Without a
   * teardown guard the bridge would resurrect its own firehose on shutdown.
   */
  it('does not resubscribe when stop() closes the firehose', async () => {
    const deps = makeDeps([room()]);
    const close = jest.fn();
    deps.gateway.subscribe1311.mockReturnValue({ close });
    const svc = makeService(deps);
    await svc.refreshRooms();
    const onclose = deps.gateway.subscribe1311.mock.calls[0][1] as (r: string[]) => void;

    svc.stop();
    onclose(['closed by caller']);
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
  });

  /**
   * `onclose` does not cover every way a subscription dies — a relay that
   * never connected is never counted toward the client's close tally, so a
   * dead subscription can report nothing at all. Silence is the backstop.
   */
  it('restarts the subscription after a silent period', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    silentFor(svc, 61 * 60_000);
    healthCheck(svc);
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ silentMinutes: 61 }),
      'subscription silent, restarting'
    );
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('leaves the subscription alone while events are still arriving', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    silentFor(svc, 61 * 60_000);
    // Any received event — including the bridge's own, dropped at L1 —
    // is proof the subscription is serving.
    await svc.handleNostrEvent(nostrEvent({ id: 'd'.repeat(64) }));
    healthCheck(svc);
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  /**
   * The case silence cannot see: a restart that lands while the relay is
   * still down fails with no close to report, so nothing else would notice
   * until the silence window expires an hour later.
   */
  it('restarts when the bridge publishes and nothing comes back', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    const roomRef = roomOf(svc, 'http://owncast-test:8080');

    await svc.handleSourceChat(roomRef, { userId: 'u1', displayName: 'A', text: 'one' });
    healthCheck(svc);
    // One window alone is not enough — a publish near the edge echoes late.
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);

    await svc.handleSourceChat(roomRef, { userId: 'u1', displayName: 'A', text: 'two' });
    healthCheck(svc);
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ echoMissStreak: 2 }),
      'published events are not coming back, restarting subscription'
    );
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('leaves the subscription alone while publishes do come back', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    const roomRef = roomOf(svc, 'http://owncast-test:8080');

    for (let i = 0; i < 4; i++) {
      await svc.handleSourceChat(roomRef, { userId: 'u1', displayName: 'A', text: `m${i}` });
      // The bridge reading its own publish back off the chat relay.
      await svc.handleNostrEvent(nostrEvent({ id: `${i}`.repeat(64) }));
      healthCheck(svc);
    }
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('does not treat a quiet room as a dead subscription', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    // Nothing published, nothing received: no evidence either way, so the
    // echo rule must stay silent and leave it to the silence backstop.
    healthCheck(svc);
    healthCheck(svc);
    healthCheck(svc);
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  /**
   * The client calls onclose synchronously from close(), so a restart
   * re-enters its own handler. Only nulling the handle first keeps that from
   * becoming a second subscription.
   */
  it('a restart re-enters its own close handler without doubling the subscription', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    const first = deps.gateway.subscribe1311.mock.results[0].value;

    silentFor(svc, 61 * 60_000);
    healthCheck(svc);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('closes the old network handle when resubscribing', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, { networkChatReadRelays: ['wss://net.test'] });
    await svc.refreshRooms();
    const first = deps.gateway.subscribeNetworkChat.mock.results[0].value;

    const onclose = deps.gateway.subscribeNetworkChat.mock.calls[0][2] as (r: string[]) => void;
    onclose(['relay connection timed out']);

    // An unclosed handle keeps its own retry timers armed and can re-open a
    // REQ the service no longer holds.
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(deps.gateway.subscribeNetworkChat).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  /**
   * The counters are split precisely so a healthy network firehose cannot
   * stand in for a dead local one. The heartbeat proves they are counted
   * apart; this proves the restart decision honours that.
   */
  it('network traffic does not satisfy the local health check', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, { networkChatReadRelays: ['wss://net.test'] });
    await svc.refreshRooms();
    const roomRef = roomOf(svc, 'http://owncast-test:8080');
    const onNetwork = deps.gateway.subscribeNetworkChat.mock.calls[0][1] as (e: Event) => void;

    for (let i = 0; i < 2; i++) {
      await svc.handleSourceChat(roomRef, { userId: 'u1', displayName: 'A', text: `m${i}` });
      onNetwork(nostrEvent({ id: `${i}`.repeat(64) }));
      await Promise.resolve();
      healthCheck(svc);
    }
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  /**
   * Closing a subscription cancels the retry the client armed for a
   * rate-limited relay, so an unfloored restart-on-close rebuilds the very
   * socket the cooldown severed, as fast as the relay can refuse it.
   */
  it('does not restart on every close when they arrive in a storm', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    const closeIt = () => {
      const calls = deps.gateway.subscribe1311.mock.calls;
      (calls[calls.length - 1][1] as (r: string[]) => void)(['rate-limited: slow down']);
    };
    closeIt();
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) closeIt();

    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(2);
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sinceRestartMs: expect.any(Number) }),
      'closes arriving faster than the restart floor, deferring to the health check'
    );
    svc.stop();
  });

  it('a refresh that finishes after stop() does not reopen the firehose', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);

    // A refresh parked on the store read while shutdown runs: it resumes
    // afterwards and must not arm a subscription no timer will ever close.
    let release!: (rows: InstanceRow[]) => void;
    deps.store.listChatRooms.mockReturnValue(
      new Promise<InstanceRow[]>((resolve) => {
        release = resolve;
      })
    );
    const parked = svc.refreshRooms();
    svc.stop();
    release([room()]);
    await parked;

    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
  });

  it('leaves the subscription alone inside the silence window', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps);
    await svc.refreshRooms();

    // A quiet half-hour is normal for a chat room, not a fault.
    silentFor(svc, 30 * 60_000);
    healthCheck(svc);
    expect(deps.gateway.subscribe1311).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('no heartbeat when the inbound direction is switched off', async () => {
    const deps = makeDeps([room()]);
    const svc = makeService(deps, null, { chatFromNostr: false });
    await svc.refreshRooms();
    beat(svc);
    expect(noopLog.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'chat bridge heartbeat'
    );
    svc.stop();
  });
});
