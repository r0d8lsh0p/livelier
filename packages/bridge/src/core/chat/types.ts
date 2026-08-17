/**
 * The chat seam between the source-agnostic room service and a source-network
 * adapter. The adapter owns every source-side mechanism — wire format
 * conversion, connection pooling, its own echo filtering — and speaks plain
 * text to the core.
 */
import type { ContentToken } from '../../../../shared/src/utils/content-processor';

/** A custom emoji used in a source chat message (NIP-30 on the Nostr side). */
export interface SourceEmoji {
  /** Shortcode without the enclosing colons. */
  shortcode: string;
  /** Absolute image URL, resolvable off the source instance's origin. */
  imageUrl: string;
}

/** A third-party chat message from the source platform, normalized. */
export interface SourceChatMessage {
  /** Stable per-user id on the source platform (chatter identity key). */
  userId: string;
  displayName: string;
  /** Plain text — the adapter converts from the source's wire format. */
  text: string;
  /** Custom emoji the message used, so the bridged event can carry NIP-30
   * emoji tags and Nostr clients can render the images. */
  emojis?: SourceEmoji[];
}

/** A third-party user joining the source chat room. Sources typically
 * announce arrivals only — presence built on this decays by expiration. */
export interface SourceChatJoin {
  userId: string;
  displayName: string;
}

export interface ChatListenerHandle {
  stop(): void;
}

export interface ChatAdapter {
  readonly sourceKey: string;
  /** Human name of the network, used in chatter profile copy. */
  readonly sourceName: string;
  /**
   * Open the source-side listener for a room. The adapter emits only genuine
   * third-party messages — its own sender identities and empty bodies are
   * filtered before the callback fires. `onJoin` fires for third-party
   * arrivals (the adapter filters its own listener and sender-pool joins).
   */
  openListener(
    instanceUrl: string,
    onMessage: (msg: SourceChatMessage) => void,
    onJoin?: (join: SourceChatJoin) => void
  ): Promise<ChatListenerHandle>;
  /**
   * Deliver a Nostr chat message into the source room, attributed to
   * displayName. senderKey is a stable per-sender handle (the Nostr pubkey)
   * so the adapter can keep one source-side identity per sender. `tokens`
   * is the processed-content token stream when available — adapters whose
   * platform supports richer output (links, emoji) may render from it;
   * `text` is the plain serialization every adapter can fall back to.
   */
  sendMessage(
    instanceUrl: string,
    senderKey: string,
    displayName: string,
    text: string,
    tokens?: ContentToken[] | null
  ): Promise<void>;
  /** Tear down all source-side connections for a room. */
  closeRoom(instanceUrl: string): void;
  /** Tear down everything (service stop). */
  closeAll(): void;
}
