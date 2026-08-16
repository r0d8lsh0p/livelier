import crypto from 'crypto';
import type { Event } from 'nostr-tools';
import type { Logger } from 'pino';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
import { InstanceStore } from '../instance-store';
import { InstanceRow } from '../types';
import { FingerprintCache } from './fingerprint';
import { NostrGateway } from '../nostr/nostr-gateway';
import { DemandSource } from '../nostr/demand.client';
import { ChatAdapter, ChatListenerHandle, SourceChatJoin, SourceChatMessage } from './types';

const ROOM_REFRESH_MS = 30_000;

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
  private bridgePubkey: string;

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
    for (const room of this.rooms.values()) room.listener?.stop();
    this.rooms.clear();
    this.nostrSub?.close();
    this.nostrSub = null;
    this.networkSub?.close();
    this.networkSub = null;
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
    await this.gateway.publish(signer, 1311, msg.text, [
      ['a', room.aTag, this.config.chatRelayUrl, 'root'],
      ['-'],
      ['expiration', String(expiration)],
    ]);
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
  async handleNostrEvent(event: Event): Promise<void> {
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

    const displayName = await this.resolveName(event.pubkey);

    // L3 fingerprint.
    const fp = FingerprintCache.key(displayName, event.content);
    if (room.fingerprints.has(fp)) return;
    room.fingerprints.add(fp);

    await this.adapter.sendMessage(room.row.url, event.pubkey, displayName, event.content);
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
      about: `Chat participant on ${instanceUrl} (${this.adapter.sourceName}), bridged by an automated bridge.`,
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
   * Open the 1311 firehose once and keep it open for the life of the service.
   * The subscription is unscoped (no `#a`) so it never counts toward the
   * relay's /demand viewer aggregation, and never churns as rooms come and go
   * — events for rooms we don't hold are dropped in handleNostrEvent.
   */
  private ensureNostrSub(): void {
    if (!this.config.chatFromNostr || this.nostrSub) return;
    this.nostrSub = this.gateway.subscribe1311((event) => {
      void this.handleNostrEvent(event).catch((err) =>
        this.log.error({ err }, 'nostr→source relay failed')
      );
    });
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
    if (!this.config.chatFromNostr || this.networkSub) return;
    if (this.config.networkChatReadRelays.length === 0) return;

    this.networkSub = this.gateway.subscribeNetworkChat(
      this.config.networkChatReadRelays,
      (event) => {
        void this.handleNostrEvent(event).catch((err) =>
          this.log.error({ err }, 'network→source relay failed')
        );
      }
    );
    this.log.info(
      { relays: this.config.networkChatReadRelays.length },
      'network chat firehose opened'
    );
  }
}
