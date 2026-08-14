import WebSocket from 'ws';
import type { Logger } from 'pino';

/**
 * Nostr → Owncast sender pool (simplified port of the earlier
 * bridge implementation): one registered chat user + WS per (instance, Nostr pubkey)
 * so messages appear in Owncast under the Nostr user's display name. Tokens are
 * cached so reconnects reuse the same Owncast identity. Same presence semantics
 * as the existing bridge — each sender visibly joins the chat.
 *
 * Sends are queued per connection and paced: Owncast's flood protection silently
 * drops rapid messages from one user (verified empirically — 3 sends in the same
 * millisecond delivered only 1), so a minimum spacing is enforced per sender.
 */

const PER_INSTANCE_CAP = 50;
const SEND_SPACING_MS = 700;

interface ChatterToken {
  accessToken: string;
  userId: string;
}

interface ChatterConn {
  ws: WebSocket | null;
  queue: string[];
  /** In-flight drain loop — concurrent sends share it instead of racing. */
  draining: Promise<void> | null;
  lastSentAt: number;
}

export class OwncastChatPool {
  /** instanceUrl → nostrPubkey → connection */
  private readonly conns = new Map<string, Map<string, ChatterConn>>();
  /** instanceUrl → nostrPubkey → registration (survives WS churn) */
  private readonly tokens = new Map<string, Map<string, ChatterToken>>();

  constructor(private readonly log: Logger) {}

  /** Owncast user ids this pool registered for an instance (for echo dedup). */
  getOwncastUserIds(instanceUrl: string): Set<string> {
    const out = new Set<string>();
    for (const t of this.tokens.get(instanceUrl)?.values() ?? []) out.add(t.userId);
    return out;
  }

  async send(
    instanceUrl: string,
    nostrPubkey: string,
    displayName: string,
    htmlBody: string
  ): Promise<void> {
    const byPubkey = this.conns.get(instanceUrl) ?? new Map<string, ChatterConn>();
    this.conns.set(instanceUrl, byPubkey);

    const existing = byPubkey.get(nostrPubkey);
    if (!existing && byPubkey.size >= PER_INSTANCE_CAP) {
      throw new Error(`chat pool cap (${PER_INSTANCE_CAP}) reached for ${instanceUrl}`);
    }
    const conn: ChatterConn = existing ?? { ws: null, queue: [], draining: null, lastSentAt: 0 };
    if (!existing) byPubkey.set(nostrPubkey, conn);

    conn.queue.push(JSON.stringify({ type: 'CHAT', body: htmlBody }));
    if (!conn.draining) {
      conn.draining = this.drain(instanceUrl, nostrPubkey, displayName, conn).finally(() => {
        conn.draining = null;
      });
    }
    await conn.draining;
  }

  destroyInstance(instanceUrl: string): void {
    for (const conn of this.conns.get(instanceUrl)?.values() ?? []) conn.ws?.close();
    this.conns.delete(instanceUrl);
  }

  destroyAll(): void {
    for (const url of [...this.conns.keys()]) this.destroyInstance(url);
  }

  /** Sequentially deliver the queue with per-sender pacing. */
  private async drain(
    instanceUrl: string,
    nostrPubkey: string,
    displayName: string,
    conn: ChatterConn
  ): Promise<void> {
    while (conn.queue.length > 0) {
      if (conn.ws?.readyState !== WebSocket.OPEN) {
        await this.connect(instanceUrl, nostrPubkey, displayName, conn);
      }
      const waitMs = conn.lastSentAt + SEND_SPACING_MS - Date.now();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      const payload = conn.queue.shift();
      if (payload === undefined) break;
      conn.ws?.send(payload);
      conn.lastSentAt = Date.now();
    }
  }

  private async register(
    instanceUrl: string,
    nostrPubkey: string,
    displayName: string
  ): Promise<ChatterToken> {
    const byPubkey = this.tokens.get(instanceUrl) ?? new Map<string, ChatterToken>();
    this.tokens.set(instanceUrl, byPubkey);
    const cached = byPubkey.get(nostrPubkey);
    if (cached) return cached;

    const res = await fetch(`${instanceUrl}/api/chat/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`chat register failed: HTTP ${res.status}`);
    const json = (await res.json()) as { id: string; accessToken: string };
    const token: ChatterToken = { accessToken: json.accessToken, userId: json.id };
    byPubkey.set(nostrPubkey, token);
    return token;
  }

  /** Open (or reopen) the WS for a sender; resolves once connected. */
  private connect(
    instanceUrl: string,
    nostrPubkey: string,
    displayName: string,
    conn: ChatterConn
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.register(instanceUrl, nostrPubkey, displayName)
        .then((token) => {
          const wsUrl = `${instanceUrl.replace(/^http/, 'ws')}/ws?accessToken=${token.accessToken}`;
          const ws = new WebSocket(wsUrl);
          conn.ws = ws;
          ws.on('open', () => resolve());
          ws.on('error', (err) => {
            this.log.warn({ instance: instanceUrl, err: err.message }, 'chat pool ws error');
            reject(err);
          });
          ws.on('close', () => {
            conn.ws = null;
          });
        })
        .catch(reject);
    });
  }
}
