import type { Logger } from 'pino';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
import type { StreamMeta } from '../../../../shared/src/streaming/stream-meta';
import { InstanceStore } from '../instance-store';
import { LiveEventPublisher, buildBridgedProfileContent } from '../nostr/live-event.publisher';
import { PollCycleMetrics, anyRelayAccepted, newCycleMetrics } from '../metrics';
import { InstanceRow } from '../types';
import { dTagFor, instanceSigner, profileHash } from '../identity';
import { DiscoveredLive, DiscoveryAdapter } from './types';

/** The engine's slice of configuration — per source, since each engine runs one adapter. */
export interface DiscoveryEngineConfig {
  bridgeKeySecret: string;
  /** Relay for durable discovery events (30311s). */
  eventRelayUrl: string;
  /** Relay hosting the 1311 chat room + per-instance host kind-0s. */
  chatRelayUrl: string;
  /**
   * Every relay instance kind-0s publish to: the chat relay, plus the
   * network profile-write set when NETWORK_PROFILE_PUBLISH_ENABLED.
   */
  profileWriteRelays: string[];
  pollIntervalMs: number;
  republishIntervalMs: number;
  snapshotIntervalMs: number;
  maxConsecutiveFailures: number;
  /**
   * Posture stamped onto newly discovered rows (inside the INSERT). Existing
   * rows are never swept to match — per-row settings always stick; changing
   * posture for existing rows is a scripted operator action.
   */
  defaultDiscoveryEnabled: boolean;
  defaultChatEnabled: boolean;
}

/**
 * Source-agnostic discovery lifecycle: poll the adapter's live set, publish
 * hash-gated kind-0 profiles and kind-30311 live events, heartbeat-republish
 * while live, and reconcile disappeared instances to `ended` after N
 * consecutive liveness failures. Stream liveness (via the adapter) is the
 * source of truth; the adapter's live set is discovery. All state persists in
 * Postgres, scoped by the adapter's source key.
 */
export class DiscoveryBridgeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private lastSchemaVersion: string | null = null;
  private lastSnapshotAt: number | null = null;

  constructor(
    private readonly config: DiscoveryEngineConfig,
    private readonly adapter: DiscoveryAdapter,
    private readonly store: InstanceStore,
    private readonly publisher: LiveEventPublisher,
    /** The single bridge identity — author of every 30311. */
    private readonly bridgeSigner: DerivedKeySigner,
    private readonly log: Logger
  ) {}

  async start(): Promise<void> {
    await this.store.init();
    // Resume the hourly snapshot cadence across restarts.
    const latest = await this.store.latestSnapshotAt(this.adapter.sourceKey);
    this.lastSnapshotAt = latest ? new Date(latest).getTime() : null;
    this.log.info(
      {
        source: this.adapter.sourceKey,
        bridgePubkey: this.bridgeSigner.getPublicKey(),
        eventRelay: this.config.eventRelayUrl,
        chatRelay: this.config.chatRelayUrl,
        pollIntervalMs: this.config.pollIntervalMs,
      },
      'discovery bridge starting'
    );
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.scheduleNext(this.config.pollIntervalMs);
      return;
    }
    this.running = true;
    try {
      const metrics = await this.runCycle();
      this.log.info({ source: this.adapter.sourceKey, metrics }, 'poll cycle complete');
    } catch (err) {
      this.log.error({ err }, 'poll cycle failed');
    } finally {
      this.running = false;
      this.scheduleNext(this.config.pollIntervalMs);
    }
  }

  /** One full poll cycle. Exposed for tests. */
  async runCycle(): Promise<PollCycleMetrics> {
    const metrics = newCycleMetrics();
    const startedAt = Date.now();

    let live: DiscoveredLive[] = [];
    let rawLive: unknown[] = [];
    try {
      const result = await this.adapter.fetchLive();
      metrics.directoryOk = true;
      metrics.schemaVersion = result.schemaVersion;
      if (this.lastSchemaVersion && this.lastSchemaVersion !== result.schemaVersion) {
        this.log.warn(
          { from: this.lastSchemaVersion, to: result.schemaVersion },
          'source schema drift detected'
        );
      }
      this.lastSchemaVersion = result.schemaVersion;
      rawLive = result.raw;
      live = result.live;
      metrics.liveInDirectory = live.length;
    } catch (err) {
      // Source outage: keep last-known state, never reap on a single failure.
      this.log.warn({ err }, 'live-set fetch failed; keeping last-known state');
      metrics.durationMs = Date.now() - startedAt;
      return metrics;
    }

    const liveUrls = new Set<string>();
    for (const instance of live) {
      liveUrls.add(instance.url);
      await this.processLive(instance, metrics);
    }

    await this.processManualRows(liveUrls, metrics);
    await this.reconcileDisappeared(liveUrls, metrics);

    // Hourly observation snapshot: raw source JSON of the live set + this
    // cycle's liveness numbers. Only after a successful live-set fetch.
    const snapshotDue =
      this.lastSnapshotAt === null ||
      Date.now() - this.lastSnapshotAt >= this.config.snapshotIntervalMs;
    if (snapshotDue) {
      await this.store.insertLiveSnapshot({
        source: this.adapter.sourceKey,
        raw: rawLive,
        directoryLiveCount: live.length,
        bridgedLiveCount: live.length,
        hlsLive: metrics.hlsLive,
        hlsEnded: metrics.hlsEnded,
        hlsError: metrics.hlsError,
        schemaVersion: metrics.schemaVersion,
      });
      this.lastSnapshotAt = Date.now();
      metrics.snapshotTaken = true;
    }

    metrics.durationMs = Date.now() - startedAt;
    return metrics;
  }

  private signerFor(instanceUrl: string): DerivedKeySigner {
    return instanceSigner(instanceUrl, this.config.bridgeKeySecret, this.adapter.sourceKey);
  }

  private async processLive(instance: DiscoveredLive, metrics: PollCycleMetrics): Promise<void> {
    const signer = this.signerFor(instance.url);
    const dTag = dTagFor(instance.url, this.adapter.dTagPrefix);

    const { row, isNew } = await this.store.upsertSeen({
      url: instance.url,
      source: this.adapter.sourceKey,
      pubkey: signer.getPublicKey(),
      d_tag: dTag,
      name: instance.name,
      stream_title: instance.streamTitle,
      description: instance.description,
      image: instance.image,
      nsfw: instance.nsfw,
      starts_at: instance.startsAt ? new Date(instance.startsAt * 1000) : null,
      hls_url: instance.streamUrl,
      discovery_enabled: this.config.defaultDiscoveryEnabled,
      chat_enabled: this.config.defaultChatEnabled,
    });
    if (isNew) metrics.newInstances += 1;

    // Opted out: the row keeps tracking directory metadata (above), but the
    // instance gets no liveness probes and nothing new reaches the relays.
    // Deliberately NOTHING more: already-published events stay put — removing
    // them is a separate manual operator action (operations/retract-instance.mjs),
    // so "stop bridging forward, keep the history" remains possible.
    if (!row.discovery_enabled) {
      metrics.disabledSkipped += 1;
      return;
    }

    // Stream liveness is the source of truth. On error, fall back to live-set
    // membership (the instance is in the live set), but record the error.
    const liveness = await this.adapter.checkLiveness(instance.streamUrl);
    if (liveness === 'live') metrics.hlsLive += 1;
    else if (liveness === 'ended') metrics.hlsEnded += 1;
    else metrics.hlsError += 1;

    const status: 'live' | 'ended' = liveness === 'ended' ? 'ended' : 'live';

    await this.maybePublishProfile(
      signer,
      {
        name: instance.name || instance.url,
        description: instance.description,
        picture: instance.picture,
        website: instance.url,
      },
      row,
      metrics
    );

    // Viewer count polls every cycle; a change publishes NOW, and because
    // last_published_at moves on every actual publish, the change publish
    // also restarts the heartbeat clock (poll 1 min / heartbeat 15 min /
    // publish-on-change).
    const polledViewers =
      status === 'live' ? await this.adapter.fetchViewerCount?.(instance.url) : undefined;
    const viewersChanged = polledViewers !== undefined && polledViewers !== row.viewer_count;

    const republishDue =
      !row.last_published_at ||
      Date.now() - new Date(row.last_published_at).getTime() >= this.config.republishIntervalMs;
    const statusChanged = row.status !== status;
    const shouldPublish = isNew || statusChanged || republishDue || viewersChanged;

    if (shouldPublish) {
      const meta: StreamMeta = {
        title: instance.streamTitle || instance.name || 'Live',
        summary: instance.description || '',
        image: instance.image,
        tags: instance.tags,
      };
      const result = await this.publisher.publishLiveEvent({
        signer: this.bridgeSigner,
        hostPubkey: signer.getPublicKey(),
        dTag,
        metadata: meta,
        streamingUrl: instance.streamUrl,
        startsTimestamp:
          instance.startsAt ?? Math.floor(new Date(row.first_seen_at).getTime() / 1000),
        status,
        proxyUrl: instance.url,
        proxyProtocol: this.adapter.proxyProtocol,
        relayUrl: this.config.eventRelayUrl,
        chatRelayUrl: this.config.chatRelayUrl,
        nsfw: instance.nsfw,
        currentParticipants:
          (polledViewers !== undefined ? polledViewers : row.viewer_count) ?? undefined,
      });
      metrics.published30311 += 1;
      if (!anyRelayAccepted(result)) metrics.relayWriteFailures += 1;
    }

    // last_published_at only moves when a publish actually happened —
    // bumping it every cycle would keep the republish heartbeat forever due.
    // viewer_count is the last PUBLISHED count, so it moves on publish only.
    await this.store.update(instance.url, {
      status,
      last_liveness: liveness,
      consecutive_failures: liveness === 'error' ? row.consecutive_failures : 0,
      ...(shouldPublish ? { last_published_at: new Date() } : {}),
      ...(shouldPublish && polledViewers !== undefined ? { viewer_count: polledViewers } : {}),
    });
  }

  private async maybePublishProfile(
    signer: DerivedKeySigner,
    source: { name: string; description: string; picture: string; website: string },
    row: InstanceRow,
    metrics: PollCycleMetrics
  ): Promise<void> {
    const profile = { ...source, sourceName: this.adapter.sourceName };
    const hash = profileHash(buildBridgedProfileContent(profile));
    if (row.profile_hash === hash) return;

    const result = await this.publisher.publishProfile(
      signer,
      profile,
      // Instance profiles are signed by per-instance derived keys, and the
      // event relay (SW2) whitelists ONLY the bridge author pubkey — so they
      // route to the chat relay (kind 0 accepted, TTL-exempt), plus the
      // network profile-write set when the flag is on.
      this.config.profileWriteRelays
    );
    metrics.publishedProfiles += 1;
    if (!anyRelayAccepted(result)) metrics.relayWriteFailures += 1;
    await this.store.update(row.url, { profile_hash: hash });
  }

  /**
   * Manually-added instances (origin = 'manual') are not in the source's live
   * set, so they get their own liveness + publish pass: live rows are
   * (re)published as live 30311s from stored row metadata; non-live rows are
   * left to reconcileDisappeared's failure-counting teardown.
   */
  private async processManualRows(
    liveUrls: Set<string>,
    metrics: PollCycleMetrics
  ): Promise<void> {
    const manualRows = await this.store.listManual(this.adapter.sourceKey);
    for (const row of manualRows) {
      if (liveUrls.has(row.url)) continue;
      if (!row.discovery_enabled) {
        metrics.disabledSkipped += 1;
        continue;
      }

      const liveness = await this.adapter.checkLiveness(row.hls_url);
      if (liveness !== 'live') continue; // reconcileDisappeared handles teardown
      metrics.hlsLive += 1;
      liveUrls.add(row.url);

      // Manual rows are first-class bridged instances: the 30311's host `p`
      // tag must resolve to a kind-0, so publish one from stored row
      // metadata, hash-gated exactly like the discovered path.
      await this.maybePublishProfile(
        this.signerFor(row.url),
        {
          name: row.name || row.url,
          description: row.description,
          picture: row.image,
          website: row.url,
        },
        row,
        metrics
      );

      const wasEnded = row.status === 'ended';
      // Reset starts on an ended→live transition, else preserve the original.
      const startsTimestamp =
        wasEnded || !row.starts_at
          ? Math.floor(Date.now() / 1000)
          : Math.floor(new Date(row.starts_at).getTime() / 1000);
      const polledViewers = await this.adapter.fetchViewerCount?.(row.url);
      const viewersChanged = polledViewers !== undefined && polledViewers !== row.viewer_count;
      const republishDue =
        !row.last_published_at ||
        Date.now() - new Date(row.last_published_at).getTime() >= this.config.republishIntervalMs;
      if (!wasEnded && !republishDue && !viewersChanged) {
        await this.store.update(row.url, {
          status: 'live',
          last_liveness: liveness,
          consecutive_failures: 0,
        });
        continue;
      }

      const result = await this.publisher.publishLiveEvent({
        signer: this.bridgeSigner,
        hostPubkey: row.pubkey,
        dTag: row.d_tag,
        metadata: {
          title: row.stream_title || row.name || 'Live',
          summary: row.description || '',
          image: row.image,
          tags: [],
        },
        streamingUrl: row.hls_url,
        startsTimestamp,
        status: 'live',
        proxyUrl: row.url,
        proxyProtocol: this.adapter.proxyProtocol,
        relayUrl: this.config.eventRelayUrl,
        chatRelayUrl: this.config.chatRelayUrl,
        nsfw: row.nsfw,
        currentParticipants:
          (polledViewers !== undefined ? polledViewers : row.viewer_count) ?? undefined,
      });
      metrics.published30311 += 1;
      if (!anyRelayAccepted(result)) metrics.relayWriteFailures += 1;
      await this.store.update(row.url, {
        status: 'live',
        last_liveness: liveness,
        consecutive_failures: 0,
        starts_at: new Date(startsTimestamp * 1000),
        last_published_at: new Date(),
        ...(polledViewers !== undefined ? { viewer_count: polledViewers } : {}),
      });
    }
  }

  /**
   * Instances that were live but have dropped out of the source's live set:
   * confirm via the adapter's liveness probe, and after N consecutive failures
   * publish a terminal `ended` 30311 and flip the row.
   */
  private async reconcileDisappeared(
    liveUrls: Set<string>,
    metrics: PollCycleMetrics
  ): Promise<void> {
    const activeRows = await this.store.listByStatus('live', this.adapter.sourceKey);
    for (const row of activeRows) {
      if (liveUrls.has(row.url)) continue;
      // Opted out: no probes, no teardown publishes — the flag stops the
      // machine entirely; relay state is the operator's to change.
      if (!row.discovery_enabled) continue;

      const liveness = await this.adapter.checkLiveness(row.hls_url);
      if (liveness === 'live') {
        // Live-set lag — still live per the source of truth. Reset failures.
        await this.store.update(row.url, { consecutive_failures: 0, last_liveness: 'live' });
        continue;
      }

      const failures = row.consecutive_failures + 1;
      if (failures < this.config.maxConsecutiveFailures) {
        await this.store.update(row.url, {
          consecutive_failures: failures,
          last_liveness: liveness,
        });
        continue;
      }

      // Teardown: publish an ended event and mark the row.
      const meta: StreamMeta = {
        title: row.stream_title || row.name || 'Live',
        summary: row.description || '',
        image: row.image,
        tags: [],
      };
      const result = await this.publisher.publishLiveEvent({
        signer: this.bridgeSigner,
        hostPubkey: row.pubkey,
        dTag: row.d_tag,
        metadata: meta,
        streamingUrl: row.hls_url,
        startsTimestamp: row.starts_at
          ? Math.floor(new Date(row.starts_at).getTime() / 1000)
          : Math.floor(new Date(row.first_seen_at).getTime() / 1000),
        status: 'ended',
        proxyUrl: row.url,
        proxyProtocol: this.adapter.proxyProtocol,
        relayUrl: this.config.eventRelayUrl,
        chatRelayUrl: this.config.chatRelayUrl,
        nsfw: row.nsfw,
      });
      if (!anyRelayAccepted(result)) metrics.relayWriteFailures += 1;
      metrics.endedThisCycle += 1;
      await this.store.update(row.url, {
        status: 'ended',
        last_liveness: liveness,
        consecutive_failures: failures,
        last_published_at: new Date(),
      });
    }
  }

}
