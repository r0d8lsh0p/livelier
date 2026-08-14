import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Logger } from 'pino';

/** A chat message received from an Owncast instance. */
export interface OwncastChatMessage {
  userId: string;
  displayName: string;
  /** Raw HTML body as delivered by Owncast. */
  body: string;
}

/** A user joining an Owncast chat room (Owncast broadcasts joins, never leaves). */
export interface OwncastChatJoin {
  userId: string;
  displayName: string;
}

interface RegisterResponse {
  id: string;
  accessToken: string;
  displayName: string;
}

/**
 * Parse a raw WS frame from Owncast into typed messages. Owncast may batch
 * multiple JSON objects separated by newlines. Exported for tests.
 */
export function parseOwncastFrames(data: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of data.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON frame — ignore.
    }
  }
  return out;
}

/**
 * Owncast → Nostr listener for one instance: registers a chat user (the bridge's
 * honest display name — the join message IS the disclosure, same mechanism as
 * the earlier bridge implementation) and emits `chat` events for other users' messages.
 *
 * Reconnects with patient backoff so a flaky instance sees one considered rejoin,
 * not a join/leave strobe.
 */
export class OwncastChatListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 15_000;
  /** Chat user id the listener itself registered — its own messages are skipped. */
  ownUserId: string | null = null;

  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60_000;

  constructor(
    readonly instanceUrl: string,
    private readonly displayName: string,
    private readonly log: Logger
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const registration = await this.register();
      this.ownUserId = registration.id;
      const wsUrl = `${this.instanceUrl.replace(/^http/, 'ws')}/ws?accessToken=${registration.accessToken}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelayMs = 15_000;
        this.log.info({ instance: this.instanceUrl }, 'owncast chat listener connected');
      });
      ws.on('message', (data) => this.handleFrame(data.toString()));
      ws.on('close', () => this.scheduleReconnect());
      ws.on('error', (err) => {
        this.log.warn({ instance: this.instanceUrl, err: err.message }, 'owncast chat ws error');
      });
    } catch (err) {
      this.log.warn({ instance: this.instanceUrl, err }, 'owncast chat connect failed');
      this.scheduleReconnect();
    }
  }

  private async register(): Promise<RegisterResponse> {
    const res = await fetch(`${this.instanceUrl}/api/chat/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: this.displayName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`chat register failed: HTTP ${res.status}`);
    return (await res.json()) as RegisterResponse;
  }

  private handleFrame(data: string): void {
    for (const msg of parseOwncastFrames(data)) {
      const user = msg.user as { id?: string; displayName?: string } | undefined;
      const userId = user?.id ?? '';
      if (!userId || userId === this.ownUserId) continue; // own frames

      if (msg.type === 'USER_JOINED') {
        const join: OwncastChatJoin = {
          userId,
          displayName: user?.displayName ?? 'unknown',
        };
        this.emit('join', join);
        continue;
      }
      if (msg.type !== 'CHAT') continue;
      const chat: OwncastChatMessage = {
        userId,
        displayName: user?.displayName ?? 'unknown',
        body: String(msg.body ?? ''),
      };
      this.emit('chat', chat);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      OwncastChatListener.MAX_RECONNECT_DELAY_MS
    );
    this.log.info({ instance: this.instanceUrl, delayMs: delay }, 'owncast chat reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
