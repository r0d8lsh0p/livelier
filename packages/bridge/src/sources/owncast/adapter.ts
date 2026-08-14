import type { Logger } from 'pino';
import { DiscoveredLive, DiscoveryAdapter, DiscoveryResult, Liveness } from '../../core/discovery/types';
import { ChatAdapter, ChatListenerHandle, SourceChatJoin, SourceChatMessage } from '../../core/chat/types';
import { fetchDirectory } from './discovery/directory.client';
import { checkOwncastHlsLiveness } from './discovery/liveness';
import { DirectoryInstance } from './discovery/types';
import { OwncastChatListener, OwncastChatJoin, OwncastChatMessage } from './chat/owncast-listener';
import { OwncastChatPool } from './chat/chat-pool';
import { owncastHtmlToText, textToOwncastHtml } from './chat/html';

export interface OwncastAdapterConfig {
  /** Owncast directory feed (`/api/home`). */
  directoryUrl: string;
  /** HLS liveness fetch timeout (ms). */
  hlsTimeoutMs: number;
  /** Bridge display name — the honest join name for chat listeners/senders. */
  bridgeName: string;
  log: Logger;
}

/**
 * Parse the directory's `streamingSince` (ISO-8601) to Unix seconds for the
 * NIP-53 `starts` tag. Returns null for missing/invalid values so the engine
 * can fall back deliberately.
 */
export function parseStreamingSince(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** Build the absolute picture URL from the instance origin + directory `logo`. */
function pictureUrl(instanceUrl: string, logo: string): string {
  if (!logo) return `${instanceUrl}/logo`;
  if (logo.startsWith('http://') || logo.startsWith('https://')) return logo;
  return `${instanceUrl}${logo.startsWith('/') ? '' : '/'}${logo}`;
}

function hlsUrlFor(instanceUrl: string): string {
  return `${instanceUrl}/hls/stream.m3u8`;
}

/** Map a directory instance to the engine's normalized shape. */
export function toDiscoveredLive(instance: DirectoryInstance): DiscoveredLive {
  return {
    url: instance.url,
    name: instance.name,
    streamTitle: instance.streamTitle,
    description: instance.description,
    picture: pictureUrl(instance.url, instance.logo),
    image: `${instance.url}/thumbnail.jpg`,
    nsfw: instance.nsfw,
    startsAt: parseStreamingSince(instance.streamingSince),
    streamUrl: hlsUrlFor(instance.url),
    tags: instance.tags.map((t) => t.slug).filter(Boolean),
  };
}

/**
 * Owncast adapter, both halves of the bridge seam.
 *
 * Discovery: the public directory is the live-set feed, and the slate-aware
 * HLS probe is ground truth (Owncast keeps serving playlists of offline-slate
 * segments after a stream ends).
 *
 * Chat: Owncast's bespoke chat websocket — register-then-join listeners for
 * ingest, a paced per-sender connection pool for egress, and HTML↔text
 * conversion at this boundary so the core only ever sees plain text.
 */
export class OwncastAdapter implements DiscoveryAdapter, ChatAdapter {
  readonly sourceKey = 'owncast';
  readonly sourceName = 'Owncast';
  readonly dTagPrefix = 'oc';
  readonly proxyProtocol = 'web';

  private readonly pool: OwncastChatPool;

  constructor(private readonly config: OwncastAdapterConfig) {
    this.pool = new OwncastChatPool(config.log);
  }

  async fetchLive(): Promise<DiscoveryResult> {
    const parsed = await fetchDirectory(this.config.directoryUrl, Date.now());
    // No NSFW filtering at the bridge — the flag is carried through as a
    // NIP-36 content-warning tag on the 30311 instead.
    return {
      live: parsed.live.map(toDiscoveredLive),
      raw: parsed.rawLive,
      schemaVersion: parsed.schemaVersion,
    };
  }

  async checkLiveness(streamUrl: string): Promise<Liveness> {
    return checkOwncastHlsLiveness(streamUrl, this.config.hlsTimeoutMs);
  }

  /**
   * Owncast exposes `viewerCount` on the public `/api/status` — unless the
   * operator hides it (the field is simply absent), which maps to `null`.
   */
  async fetchViewerCount(instanceUrl: string): Promise<number | null | undefined> {
    try {
      const res = await fetch(`${instanceUrl}/api/status`, {
        signal: AbortSignal.timeout(this.config.hlsTimeoutMs),
      });
      if (!res.ok) return undefined;
      const status = (await res.json()) as { viewerCount?: unknown };
      return typeof status.viewerCount === 'number' ? status.viewerCount : null;
    } catch {
      return undefined;
    }
  }

  async openListener(
    instanceUrl: string,
    onMessage: (msg: SourceChatMessage) => void,
    onJoin?: (join: SourceChatJoin) => void
  ): Promise<ChatListenerHandle> {
    const listener = new OwncastChatListener(instanceUrl, this.config.bridgeName, this.config.log);
    listener.on('chat', (msg: OwncastChatMessage) => {
      // Skip messages sent by our own sender pool (they came FROM Nostr).
      if (this.pool.getOwncastUserIds(instanceUrl).has(msg.userId)) return;
      const text = owncastHtmlToText(msg.body);
      if (!text) return;
      onMessage({ userId: msg.userId, displayName: msg.displayName, text });
    });
    if (onJoin) {
      listener.on('join', (join: OwncastChatJoin) => {
        // Sender-pool identities joining is our own doing, not third-party presence.
        if (this.pool.getOwncastUserIds(instanceUrl).has(join.userId)) return;
        onJoin({ userId: join.userId, displayName: join.displayName });
      });
    }
    await listener.start();
    return listener;
  }

  async sendMessage(
    instanceUrl: string,
    senderKey: string,
    displayName: string,
    text: string
  ): Promise<void> {
    await this.pool.send(instanceUrl, senderKey, displayName, textToOwncastHtml(text));
  }

  closeRoom(instanceUrl: string): void {
    this.pool.destroyInstance(instanceUrl);
  }

  closeAll(): void {
    this.pool.destroyAll();
  }
}
