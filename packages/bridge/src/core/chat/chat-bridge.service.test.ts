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
    subscribe1311: jest.fn().mockReturnValue({ close: jest.fn() }),
    subscribeNetworkChat: jest.fn().mockReturnValue({ close: jest.fn() }),
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
    expect(deps.gateway.subscribe1311).toHaveBeenCalledWith(expect.any(Function));
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
});
