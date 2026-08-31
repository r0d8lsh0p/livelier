import crypto from 'crypto';
import type { Event } from 'nostr-tools';
import type { Logger } from 'pino';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
import { InstanceStore } from '../instance-store';
import { InstanceRow } from '../types';
import { processNostrContent } from './content-render';
import { FingerprintCache } from './fingerprint';
import { NostrGateway } from '../nostr/nostr-gateway';
import { DemandSource } from '../nostr/demand.client';
import { ChatAdapter, ChatListenerHandle, SourceChatJoin, SourceChatMessage } from './types';

const ROOM_REFRESH_MS = 30_000;
/** Heartbeat cadence — independent of the room refresh, see logHeartbeat. */
const HEARTBEAT_MS = 30_000;
/** Subscription health-check cadence. */
const HEALTH_CHECK_MS = 60_000;
/** Silence tolerated before the subscription is rebuilt regardless. */
const MAX_SILENCE_MS = 60 * 60_000;
/** Consecutive health checks with publishes but no echo before rebuilding. */
const ECHO_MISS_RESTART = 2;
/** Minimum gap between close-driven restarts — see the close handler. */
const MIN_RESTART_INTERVAL_MS = 30_000;
/** Share of a subscription's relays that must drop before it is rebuilt. */
const RELAY_DISCONNECT_THRESHOLD = 0.75;
/** The 1311 firehose is pinned to the one chat relay. */
const LOCAL_FIREHOSE_RELAYS = 1;

/** The chat service's slice of configuration — per source. */
export interface ChatServiceConfig {
  /** Bridge display name: the `client` tag (L1 dedup) and the listener's honest join name. */
  bridgeName: string;
  /** Relay hosting the 1311 rooms and bridged chatter identities. */
  chatRelayUrl: string;
  /** Every relay chatter kind-0/10002s publish to (chat relay + network set when enabled). */
  profileWriteRelays: string[];
  /** Network relays additionally watched for our rooms' chat kinds. Empty = local only. */
  networkChatReadRelays: string[];
  /** Gate: bridge source chat → Nostr kind-1311. */
  chatToNostr: boolean;
  /** Gate: deliver Nostr kind-1311 → source chat. */
  chatFromNostr: boolean;
  /** NIP-40 lifetime (seconds) stamped on every bridged 1311. */
  chatExpirationSeconds: number;
  /** How often to poll /demand (ms). */
  demandPollIntervalMs: number;
}

interface Room {
  row: InstanceRow;
  aTag: string;
  listener: ChatListenerHandle | null;
  /** Source userId → ephemeral chatter signer (existing-bridge semantics). */
  chatterSigners: Map<string, DerivedKeySigner>;
  /** Chatters whose kind-0/10002 were already published this session. */
  profiledChatters: Set<string>;
  fingerprints: FingerprintCache;
  /**
   * FIFO delivery chain. Name resolution and content rendering are async
   * with per-message latency (profile lookups), so unchained deliveries
   * would reach the source in completion order, not arrival order.
   */
  delivery: Promise<void>;
}

/**
 * Two-way kind-1311 chat bridge, source-agnostic: register-then-join presence
 * (the join IS the disclosure), ephemeral per-chatter keys, and 3-layer dedup —
 * L1 client tag, L2 bridged-pubkey set, L3 content fingerprint. All source-side
 * mechanics live behind the ChatAdapter.
 *
 * Rooms come from the instance store: rows of this adapter's source with
 * `chat_enabled` (the per-instance allowlist) and status `live`. Each direction
 * is gated independently.
 */
export class ChatBridgeService {
  private readonly rooms = new Map<string, Room>(); // instanceUrl → room
  private readonly bridgedPubkeys = new Set<string>(); // L2
  private readonly nameCache = new Map<string, string>();
  private nostrSub: { close: () => void } | null = null;
  private networkSub: { close: () => void } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private demandTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private bridgePubkey: string;
  /**
   * Traffic since the last heartbeat. Counted per firehose, not pooled: the
   * local and network subscriptions fail independently, and a healthy
   * network firehose would otherwise mask a dead local one — which carries
   * almost all real traffic.
   */
  private localSeen = 0;
  private networkSeen = 0;
  private inboundDelivered = 0;
  private outboundPublished = 0;
  /** Set by stop(), so the close handlers do not resubscribe on teardown. */
  private stopped = false;
  /** Health-monitor state — see checkSubscriptionHealth. */
  private lastEventTime = Date.now();
  /** Relays reported closed since the last restart — see the close handler. */
  private disconnectedRelayCount = 0;
  /** Per-health-check echo accounting — see checkSubscriptionHealth. */
  private publishedSinceCheck = 0;
  private seenSinceCheck = 0;
  private echoMissStreak = 0;
  /** When the firehose was last rebuilt, to rate-limit close-driven restarts. */
  private lastRestartAt = 0;

  constructor(
    private readonly config: ChatServiceConfig,
    private readonly store: InstanceStore,
    private readonly gateway: NostrGateway,
    private readonly adapter: ChatAdapter,
    private readonly bridgeSigner: DerivedKeySigner,
    private readonly log: Logger,
    private readonly demand: DemandSource | null = null
  ) {
    this.bridgePubkey = bridgeSigner.getPublicKey();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.lastEventTime = Date.now();
    this.disconnectedRelayCount = 0;
    this.publishedSinceCheck = 0;
    this.seenSinceCheck = 0;
    this.echoMissStreak = 0;
    this.lastRestartAt = 0;
    this.log.info(
      {
        source: this.adapter.sourceKey,
        toNostr: this.config.chatToNostr,
        fromNostr: this.config.chatFromNostr,
      },
      'chat bridge starting'
    );
    await this.refreshRooms();
    this.refreshTimer = setInterval(() => {
      void this.refreshRooms().catch((err) =>
        this.log.error({ err }, 'chat room refresh failed')
      );
    }, ROOM_REFRESH_MS);
    this.heartbeatTimer = setInterval(() => this.logHeartbeat(), HEARTBEAT_MS);
    this.healthTimer = setInterval(() => this.checkSubscriptionHealth(), HEALTH_CHECK_MS);
    if (this.demand && this.config.chatToNostr) {
      await this.pollDemand().catch((err) =>
        this.log.error({ err }, 'initial demand poll failed')
      );
      this.demandTimer = setInterval(() => {
        void this.pollDemand().catch((err) => this.log.error({ err }, 'demand poll failed'));
      }, this.config.demandPollIntervalMs);
    }
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.demandTimer) {
      clearInterval(this.demandTimer);
      this.demandTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const room of this.rooms.values()) room.listener?.stop();
    this.rooms.clear();
    // Detach before closing: the close handlers resubscribe, and must not
    // bring the firehose back up behind a stop().
    this.stopped = true;
    const nostrSub = this.nostrSub;
    const networkSub = this.networkSub;
    this.nostrSub = null;
    this.networkSub = null;
    nostrSub?.close();
    networkSub?.close();
    this.adapter.closeAll();
  }

  /** Reconcile active rooms with the allowlist (chat_enabled AND live). */
  async refreshRooms(): Promise<void> {
    const rows = await this.store.listChatRooms(this.adapter.sourceKey);
    const wanted = new Map(rows.map((r) => [r.url, r]));

    // Tear down rooms no longer wanted.
    for (const [url, room] of this.rooms) {
      if (wanted.has(url)) continue;
      this.log.info({ instance: url }, 'chat room closing');
      room.listener?.stop();
      this.adapter.closeRoom(url);
      this.rooms.delete(url);
    }

    // Bring up new rooms.
    for (const [url, row] of wanted) {
      if (this.rooms.has(url)) continue;
      const room: Room = {
        row,
        aTag: `30311:${this.bridgePubkey}:${row.d_tag}`,
        listener: null,
        chatterSigners: new Map(),
        profiledChatters: new Set(),
        fingerprints: new FingerprintCache(),
        delivery: Promise.resolve(),
      };
      this.rooms.set(url, room);
      this.log.info({ instance: url, aTag: room.aTag }, 'chat room opening');
      // With a demand source, the source-side listener waits for a Nostr
      // viewer to name this room's `#a`; without one, connect eagerly.
      if (this.config.chatToNostr && !this.demand) {
        await this.startListener(room);
      }
    }

    this.ensureNostrSub();
    this.ensureNetworkSub();
  }

  /**
   * Say out loud what each firehose is carrying. A lost subscription raises
   * no error and delivers no events, so it reads exactly like rooms that
   * happen to be quiet — this is the only place the difference is visible.
   *
   * Runs on its own timer rather than at the end of refreshRooms(): an
   * observability signal must not go quiet because a database read or a
   * source connection upstream of it is hanging.
   */
  private logHeartbeat(): void {
    if (this.config.chatFromNostr) {
      const listeners = [...this.rooms.values()].filter((r) => r.listener !== null).length;
      this.log.info(
        {
          rooms: this.rooms.size,
          listeners,
          localSeen: this.localSeen,
          networkSeen: this.networkSeen,
          outboundPublished: this.outboundPublished,
          delivered: this.inboundDelivered,
        },
        'chat bridge heartbeat'
      );
    }
    this.localSeen = 0;
    this.networkSeen = 0;
    this.inboundDelivered = 0;
    this.outboundPublished = 0;
  }

  /**
   * Establish source-side listeners for rooms with live Nostr viewer demand.
   * Establish-only: once open, a listener stays until the room itself closes
   * — tearing down on a demand dip would thrash the source chat with
   * join/leave noise.
   */
  async pollDemand(): Promise<void> {
    if (!this.demand || !this.config.chatToNostr) return;
    const demanded = await this.demand.fetchDemandedATags();
    for (const room of this.rooms.values()) {
      if (room.listener || !demanded.has(room.aTag)) continue;
      this.log.info(
        { instance: room.row.url, aTag: room.aTag },
        'nostr viewer demand — opening source chat'
      );
      await this.startListener(room);
    }
  }

  private async startListener(room: Room): Promise<void> {
    const url = room.row.url;
    room.listener = await this.adapter.openListener(
      url,
      (msg) => {
        void this.handleSourceChat(room, msg).catch((err) =>
          this.log.error({ instance: url, err }, 'source→nostr relay failed')
        );
      },
      (join) => {
        void this.handleSourceJoin(room, join).catch((err) =>
          this.log.error({ instance: url, err }, 'source→nostr presence failed')
        );
      }
    );
  }

  /**
   * Source → Nostr: a third-party arrival bridges faithfully as NIP-53 room
   * presence — the source announced a join, we announce a join, nothing more.
   */
  async handleSourceJoin(room: Room, join: SourceChatJoin): Promise<void> {
    const signer = this.chatterSigner(room, join.userId);
    if (!room.profiledChatters.has(join.userId)) {
      room.profiledChatters.add(join.userId);
      await this.publishChatterIdentity(signer, join.displayName, room.row.url);
    }
    await this.publishPresence(room, signer);
    this.log.info(
      { instance: room.row.url, who: join.displayName },
      'source→nostr presence bridged'
    );
  }

  /** Source → Nostr: publish the message as an ephemeral bridged chatter. */
  async handleSourceChat(room: Room, msg: SourceChatMessage): Promise<void> {
    if (!msg.text) return;

    // L3 fingerprint.
    const fp = FingerprintCache.key(msg.displayName, msg.text);
    if (room.fingerprints.has(fp)) return;
    room.fingerprints.add(fp);

    const signer = this.chatterSigner(room, msg.userId);
    if (!room.profiledChatters.has(msg.userId)) {
      room.profiledChatters.add(msg.userId);
      await this.publishChatterIdentity(signer, msg.displayName, room.row.url);
    }

    // Every bridge-signed 1311 carries NIP-70 `-` (no rebroadcast off the local
    // relay) and a NIP-40 expiration — bridged chatters never opted into
    // Nostr, so their mirrored messages must not outlive the relay's TTL.
    const expiration = Math.floor(Date.now() / 1000) + this.config.chatExpirationSeconds;
    const tags = [
      ['a', room.aTag, this.config.chatRelayUrl, 'root'],
      ['-'],
      ['expiration', String(expiration)],
      // NIP-30: the message's custom emoji, so clients render the images
      // where the text carries the :shortcode:.
      ...(msg.emojis ?? []).map((e) => ['emoji', e.shortcode, e.imageUrl]),
    ];
    await this.gateway.publish(signer, 1311, msg.text, tags);
    // The clock for both the heartbeat and the watchdog: this 1311 goes to
    // the chat relay, so a live local firehose must read it straight back.
    this.outboundPublished += 1;
    this.publishedSinceCheck += 1;
    this.log.info(
      { instance: room.row.url, from: msg.displayName },
      'source→nostr chat bridged'
    );
  }

  /** Ephemeral chatter identity (existing-bridge semantics: random per session). */
  private chatterSigner(room: Room, userId: string): DerivedKeySigner {
    let signer = room.chatterSigners.get(userId);
    if (!signer) {
      signer = new DerivedKeySigner(new Uint8Array(crypto.randomBytes(32)));
      room.chatterSigners.set(userId, signer);
      this.bridgedPubkeys.add(signer.getPublicKey()); // L2
    }
    return signer;
  }

  /**
   * NIP-53 room presence: kind 10312, empty content, `a` tag with relay hint
   * and `root` marker (the shape NIP-53 clients render). Carries
   * NIP-70 `-` and the same expiration as bridged 1311s — join lines and
   * messages share one lifetime, so the room's history stays coherent.
   */
  private async publishPresence(room: Room, signer: DerivedKeySigner): Promise<void> {
    const expiration = Math.floor(Date.now() / 1000) + this.config.chatExpirationSeconds;
    await this.gateway.publish(signer, 10312, '', [
      ['a', room.aTag, this.config.chatRelayUrl, 'root'],
      ['-'],
      ['expiration', String(expiration)],
    ]);
  }

  /** Nostr → source: deliver a kind-1311 into the source chat. */
  async handleNostrEvent(event: Event, via: 'local' | 'network' = 'local'): Promise<void> {
    // Counted before every filter, including events this bridge published
    // itself: reception is what the health monitor watches, not delivery.
    if (via === 'network') {
      this.networkSeen += 1;
    } else {
      this.localSeen += 1;
      this.seenSinceCheck += 1;
      this.lastEventTime = Date.now();
    }
    // Only 1311 is delivered today; the network sub also carries 1312/1313
    // for future use, and those must not land in the source chat as text.
    if (event.kind !== 1311) return;
    // L1: our own client tag.
    if (event.tags.some((t) => t[0] === 'client' && t[1] === this.config.bridgeName)) return;
    // L2: pubkeys we created.
    if (this.bridgedPubkeys.has(event.pubkey)) return;

    const aTag = event.tags.find((t) => t[0] === 'a')?.[1];
    if (!aTag) return;
    const room = [...this.rooms.values()].find((r) => r.aTag === aTag);
    if (!room) return;

    // Everything async (name resolution, content rendering, send) joins the
    // room's FIFO chain so messages reach the source in arrival order. Each
    // link swallows its own failure — one failed delivery logs and drops,
    // and must neither sever the chain nor skip the messages behind it.
    room.delivery = room.delivery.then(() =>
      this.deliverToSource(room, event).catch((err: unknown) => {
        this.log.warn(
          { instance: room.row.url, err: err instanceof Error ? err.message : String(err) },
          'nostr→source delivery failed'
        );
      })
    );
    await room.delivery;
  }

  private async deliverToSource(room: Room, event: Event): Promise<void> {
    const displayName = await this.resolveName(event.pubkey);

    // L3 fingerprint — keyed on RAW content: rendering depends on async
    // name resolution, and a name that resolves differently on a repeat
    // delivery would defeat dedup.
    const fp = FingerprintCache.key(displayName, event.content);
    if (room.fingerprints.has(fp)) return;
    room.fingerprints.add(fp);

    const { text, tokens } = await processNostrContent(event);
    // The room may have been torn down while name/render resolved — a send
    // now would reopen a source connection the bridge just closed.
    if (this.rooms.get(room.row.url) !== room) return;
    await this.adapter.sendMessage(room.row.url, event.pubkey, displayName, text, tokens);
    this.inboundDelivered += 1;
    this.log.info({ instance: room.row.url, from: displayName }, 'nostr→source chat bridged');
  }

  private async publishChatterIdentity(
    signer: DerivedKeySigner,
    displayName: string,
    instanceUrl: string
  ): Promise<void> {
    const content = JSON.stringify({
      name: displayName,
      display_name: displayName,
      about: `Chat participant on ${instanceUrl}, bridged from ${this.adapter.sourceName} by https://livelier.live`,
      bot: true,
    });
    // Profile-class events go to the full profile-write set (chat relay +
    // network profile relays when enabled) so chatter names resolve in
    // network clients. Plain publish: kind 0/10002 need no NIP-42.
    await this.gateway.broadcast(signer, 0, content, [], this.config.profileWriteRelays);
    // Bridged accounts' relay lists point at the bridge chat relay, so
    // clients that find the profile know where the chatter's events live.
    await this.gateway.broadcast(
      signer,
      10002,
      '',
      [['r', this.config.chatRelayUrl]],
      this.config.profileWriteRelays
    );
  }

  private async resolveName(pubkey: string): Promise<string> {
    const cached = this.nameCache.get(pubkey);
    if (cached) return cached;
    const name = await this.gateway.fetchProfileName(pubkey);
    if (name) {
      this.nameCache.set(pubkey, name);
      return name;
    }
    // Human fallback, and deliberately NOT cached: a chatter who publishes
    // their kind-0 after their first message resolves on the next one.
    // (The source-side identity itself is sticky per sender — a rename only
    // lands once the room reopens or the pool re-registers the sender.)
    return 'Guest';
  }

  /**
   * Hold the 1311 firehose open for the life of the service, rebuilding it
   * whenever the relay ends it or the watchdog finds it silent. The
   * subscription is unscoped (no `#a`) so it never counts toward the relay's
   * /demand viewer aggregation, and never churns as rooms come and go —
   * events for rooms we don't hold are dropped in handleNostrEvent.
   */
  private ensureNostrSub(): void {
    // refreshRooms() awaits a database read and source connections, so a
    // stop() can land mid-refresh; without this the tail of that refresh
    // opens a subscription no timer will ever close.
    if (this.stopped || !this.config.chatFromNostr || this.nostrSub) return;
    this.nostrSub = this.gateway.subscribe1311(
      (event) => {
        void this.handleNostrEvent(event).catch((err) =>
          this.log.error({ err }, 'nostr→source relay failed')
        );
      },
      // Inbound chat for every room rides this one subscription, and the
      // client re-opens a REQ only after a rate-limit close — every other
      // reason, including the connection timeout that took this down in
      // production, is terminal unless the consumer rebuilds it.
      (reasons) => {
        // stop() and restartNostrSub() detach the handle before closing, so
        // reaching here with one still set means the relay ended it, not us.
        if (this.stopped || !this.nostrSub) return;
        // The client reports every relay in one call, so on a single-relay
        // subscription this proportion is always 100%. Kept proportional
        // because the same handler shape has to hold when a subscription
        // spans several relays, where losing some is not losing all.
        this.disconnectedRelayCount += reasons.length;
        const disconnectPct = (this.disconnectedRelayCount / LOCAL_FIREHOSE_RELAYS) * 100;
        this.log.warn(
          { disconnected: reasons.length, disconnectPct: disconnectPct.toFixed(1) },
          'relays disconnected'
        );
        if (disconnectPct > RELAY_DISCONNECT_THRESHOLD * 100) {
          // Floored, because restarting is not free: closing a subscription
          // cancels the retry the client armed for a rate-limited relay, and
          // re-subscribing reconnects the socket that cooldown just severed.
          // Unfloored, a relay CLOSEing every REQ turns this into a dial loop
          // bounded only by connect time. The health check picks up anything
          // deferred here within its next tick.
          const sinceRestart = Date.now() - this.lastRestartAt;
          if (sinceRestart < MIN_RESTART_INTERVAL_MS) {
            this.log.warn(
              { sinceRestartMs: sinceRestart },
              'closes arriving faster than the restart floor, deferring to the health check'
            );
            return;
          }
          this.log.warn(
            { threshold: RELAY_DISCONNECT_THRESHOLD * 100 },
            'disconnect threshold exceeded, triggering reconnection'
          );
          this.restartNostrSub();
        }
      }
    );
    this.log.info('nostr 1311 firehose subscription opened');
  }

  /**
   * Network watcher: a wide chat-kind
   * firehose on the network read set — so a correctly `#a`-tagged event
   * published to public relays by a viewer who found our 30311 on the
   * livestream relay (and never touched our chat relay) still bridges.
   * Deliberately unscoped like the local firehose: routing happens in
   * handleNostrEvent, and events for rooms we don't hold are dropped.
   * Opened once for the life of the service; inactive when the network
   * relay set is empty (flag off).
   */
  private ensureNetworkSub(): void {
    if (this.stopped || !this.config.chatFromNostr || this.networkSub) return;
    if (this.config.networkChatReadRelays.length === 0) return;

    this.networkSub = this.gateway.subscribeNetworkChat(
      this.config.networkChatReadRelays,
      (event) => {
        void this.handleNostrEvent(event, 'network').catch((err) =>
          this.log.error({ err }, 'network→source relay failed')
        );
      },
      (reasons) => {
        if (this.stopped || !this.networkSub) return;
        this.log.warn({ reasons }, 'network chat firehose closed — resubscribing');
        // Closed, not just dropped: an unclosed handle keeps its own retry
        // timers armed and can re-open a REQ into a closure nothing holds.
        const sub = this.networkSub;
        this.networkSub = null;
        sub.close();
        this.ensureNetworkSub();
      }
    );
    this.log.info(
      { relays: this.config.networkChatReadRelays.length },
      'network chat firehose opened'
    );
  }

  /**
   * Detect silence periods: if no event has arrived for more than
   * MAX_SILENCE_MS, restart the subscription. `onclose` does not cover every
   * way a subscription dies — a relay that failed to connect never counts
   * toward the client's close tally, so a dead subscription can report
   * nothing at all.
   */
  private checkSubscriptionHealth(): void {
    if (!this.config.chatFromNostr || !this.nostrSub) return;

    // Every source→Nostr 1311 is published to the chat relay this same
    // subscription reads, so the bridge's own traffic answers the question
    // silence cannot: published above zero with nothing received means the
    // subscription is gone, not that the rooms are quiet. Two windows, not
    // one — a message published near a window's edge echoes into the next.
    //
    // Two conditions this rests on. Bridged 1311s carry NIP-70 `-` and are
    // published over an authed socket while this REQ is unauthenticated, so
    // a relay that stopped serving protected events to unauthed readers
    // would make every window look like a miss. And with chatToNostr off
    // there are no publishes at all, leaving only the silence backstop.
    const echoMissing = this.publishedSinceCheck > 0 && this.seenSinceCheck === 0;
    this.publishedSinceCheck = 0;
    this.seenSinceCheck = 0;
    this.echoMissStreak = echoMissing ? this.echoMissStreak + 1 : 0;
    if (this.echoMissStreak >= ECHO_MISS_RESTART) {
      this.log.warn(
        { echoMissStreak: this.echoMissStreak },
        'published events are not coming back, restarting subscription'
      );
      this.echoMissStreak = 0;
      this.restartNostrSub();
      return;
    }

    // Backstop for when the bridge has published nothing either.
    const silentMs = Date.now() - this.lastEventTime;
    if (silentMs < MAX_SILENCE_MS) return;
    this.log.warn(
      { silentMinutes: Math.round(silentMs / 60_000) },
      'subscription silent, restarting'
    );
    this.restartNostrSub();
  }

  /** Cleanly stop the current subscription and recreate it. */
  private restartNostrSub(): void {
    this.disconnectedRelayCount = 0;
    // The new subscription must not be judged on the old one's window.
    this.publishedSinceCheck = 0;
    this.seenSinceCheck = 0;
    this.echoMissStreak = 0;
    this.lastRestartAt = Date.now();
    const sub = this.nostrSub;
    // Nulled before close(): the client invokes onclose synchronously from
    // close(), straight back into the handler below.
    this.nostrSub = null;
    sub?.close();
    this.lastEventTime = Date.now();
    this.ensureNostrSub();
  }
}
