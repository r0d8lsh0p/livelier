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
 * not a join/leave strobe — but a flaky instance and one that simply has no chat
 * to offer are different things, and only the first is worth waiting for. Two
 * guards separate them:
 *
 *   - `chatDisabled` in the instance's own `/api/config` is asked before every
 *     dial. An instance using Owncast purely as a video origin — chat turned
 *     off, or served by its own front-end — says so there, and is never
 *     registered with; asking each time also catches a streamer who turns chat
 *     off mid-session.
 *   - MAX_CONSECUTIVE_FAILURES consecutive failed attempts park the listener.
 *     Some instances answer `/api/chat/register` happily and still refuse the
 *     socket (a CDN that won't pass the upgrade, say); no amount of retrying
 *     fixes that, and rooms are established-only, so without a ceiling the
 *     retries outlive the viewer who prompted them.
 *
 * Parking is per-listener, and rooms build a fresh listener each time an
 * instance goes live, so a parked instance is re-examined on its next stream
 * rather than written off permanently.
 */
export class OwncastChatListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 15_000;
  /** Consecutive failed attempts; reset by a successful open, not by a retry. */
  private failures = 0;
  /** Set once this instance is judged to have no reachable chat. Terminal. */
  private parked = false;
  /** Chat user id the listener itself registered — its own messages are skipped. */
  ownUserId: string | null = null;

  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60_000;
  /** Attempts before an instance is judged unreachable rather than flaky. */
  static readonly MAX_CONSECUTIVE_FAILURES = 5;

  constructor(
    readonly instanceUrl: string,
    private readonly displayName: string,
    private readonly log: Logger
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.parked = false;
    this.failures = 0;
    await this.connect();
  }

  /** True once this instance has been judged to have no reachable chat. */
  get isParked(): boolean {
    return this.parked;
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
    if (this.stopped || this.parked) return;
    if (await this.chatIsDisabled()) {
      this.park('instance reports chatDisabled');
      return;
    }
    try {
      const registration = await this.register();
      this.ownUserId = registration.id;
      const wsUrl = `${this.instanceUrl.replace(/^http/, 'ws')}/ws?accessToken=${registration.accessToken}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelayMs = 15_000;
        this.failures = 0;
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

  /**
   * Ask the instance whether it runs chat at all. Read before the first dial so
   * a video-only instance is never registered with, never joined, and never
   * retried.
   *
   * Fails open on purpose: an unreadable or malformed config is not a claim
   * that chat is off, and must not close a room that would otherwise work.
   */
  private async chatIsDisabled(): Promise<boolean> {
    try {
      const res = await fetch(`${this.instanceUrl}/api/config`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const config = (await res.json()) as { chatDisabled?: boolean };
      return config.chatDisabled === true;
    } catch {
      return false;
    }
  }

  /** Give up on this instance until it next goes live. */
  private park(reason: string): void {
    this.parked = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.log.warn(
      { instance: this.instanceUrl, reason, attempts: this.failures },
      'owncast chat unavailable — parked until the instance next goes live'
    );
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
    if (this.stopped || this.parked || this.reconnectTimer) return;
    this.failures += 1;
    if (this.failures >= OwncastChatListener.MAX_CONSECUTIVE_FAILURES) {
      this.park(`${this.failures} consecutive connection failures`);
      return;
    }
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
