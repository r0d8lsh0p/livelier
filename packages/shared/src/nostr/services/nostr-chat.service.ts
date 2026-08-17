/**
 * Type-only fork of upstream's nostr-chat.service. The content processor
 * imports ChatMessage from this path; the subscription machinery the
 * upstream module also carries is app surface the bridge does not use.
 */

/**
 * Type for chat message
 */
export type ChatMessage = {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  kind: number;
  tags: string[][];
  profileName?: string;
  profilePicture?: string | null;
};
