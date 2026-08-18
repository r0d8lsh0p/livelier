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
 * to offer are different things, and only the first is worth dialling every few
 * minutes. Two signals separate them:
 *
 *   - `chatDisabled` in the instance's own `/api/config`, read before every dial.
 *     An instance using Owncast purely as a video origin — chat turned off, or
 *     served by its own front-end — says so there, and is never registered with.
 *   - MAX_CONSECUTIVE_FAILURES failed attempts in a row. Some instances answer
 *     `/api/chat/register` happily and still refuse the socket (a CDN that will
 *     not pass the upgrade, say), and rooms are established-only, so without
 *     this the retries outlive the viewer who prompted them.
 *
 * Either signal drops the listener to DORMANT_INTERVAL_MS between attempts.
 * Dormancy is deliberately NOT terminal. A room lives as long as its stream, so
 * a listener that gave up for good would turn a few minutes of local network
 * trouble into chat being dead for the rest of a multi-hour broadcast, with
 * nothing able to revive it. The instance is re-probed on a slow cadence
 * instead: cheap enough to be no burden on it, frequent enough that a recovered
 * network — or a streamer switching chat back on — is picked up within the half
 * hour.
 *
 * Leaving dormancy takes a connection that LASTS. The budget clears only after
 * MIN_HEALTHY_CONNECTION_MS of uptime, so an endpoint that accepts the upgrade
 * and drops it immediately cannot strobe by earning a fresh allowance on every
 * attempt.
 */
export class OwncastChatListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 15_000;
  /** Fires once a connection has lasted long enough to count as working. */
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed attempts; cleared only by a connection that holds. */
  private failures = 0;
  /** Whether the current socket lasted long enough to count as working. */
  private provenHealthy = false;
  /** Slow-cadence mode for an instance with no reachable chat. Not terminal. */
  private dormant = false;
  /** Chat user id the listener itself registered — its own messages are skipped. */
  ownUserId: string | null = null;

  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60_000;
  /** Failures in a row before dropping to the slow cadence. */
  static readonly MAX_CONSECUTIVE_FAILURES = 5;
  /** Gap between attempts once dormant. */
  static readonly DORMANT_INTERVAL_MS = 30 * 60_000;
  /** Uptime a connection must reach before it clears the failure budget. */
  static readonly MIN_HEALTHY_CONNECTION_MS = 30_000;

  constructor(
    readonly instanceUrl: string,
    private readonly displayName: string,
    private readonly log: Logger
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.dormant = false;
    this.failures = 0;
    this.reconnectDelayMs = 15_000;
    await this.connect();
  }

  /** True while this instance is being re-probed on the slow cadence. */
  get isDormant(): boolean {
    return this.dormant;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHealthyTimer();
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (await this.chatIsDisabled()) {
      this.goDormant('instance reports chatDisabled');
      this.arm(OwncastChatListener.DORMANT_INTERVAL_MS);
      return;
    }
    // stop() can land while either await here is in flight; resuming past it
    // would leave a live socket that nothing owns and nothing ever closes.
    if (this.stopped) return;
    try {
      const registration = await this.register();
      if (this.stopped) return;
      this.ownUserId = registration.id;
      const wsUrl = `${this.instanceUrl.replace(/^http/, 'ws')}/ws?accessToken=${registration.accessToken}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.provenHealthy = false;

      ws.on('open', () => {
        this.log.info({ instance: this.instanceUrl }, 'owncast chat listener connected');
        // Proof is uptime, not the handshake: an endpoint that accepts the
        // upgrade and drops it must not earn a fresh budget every attempt.
        this.healthyTimer = setTimeout(
          () => this.markHealthy(),
          OwncastChatListener.MIN_HEALTHY_CONNECTION_MS
        );
      });
      ws.on('message', (data) => this.handleFrame(data.toString()));
      // A connection that proved itself and then ended is a disconnect, not a
      // failed dial — it must not eat into the budget for the redial.
      ws.on('close', () => {
        this.clearHealthyTimer();
        this.scheduleReconnect({ countAsFailure: !this.provenHealthy });
      });
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
   * Ask the instance whether it runs chat at all. Read before every dial, so a
   * video-only instance is never registered with — and so one that turns chat
   * back on is noticed by the next dormant probe rather than never.
   *
   * Fails open on purpose: an unreadable or malformed config is not a claim
   * that chat is off, and must not silence a room that would otherwise work.
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

  /** A connection that held: clear the budget and leave the slow cadence. */
  private markHealthy(): void {
    this.healthyTimer = null;
    this.provenHealthy = true;
    this.failures = 0;
    this.reconnectDelayMs = 15_000;
    if (this.dormant) {
      this.dormant = false;
      this.log.info({ instance: this.instanceUrl }, 'owncast chat reachable again');
    }
  }

  private clearHealthyTimer(): void {
    if (!this.healthyTimer) return;
    clearTimeout(this.healthyTimer);
    this.healthyTimer = null;
  }

  /** Drop to the slow cadence. Logged once per transition, not per attempt. */
  private goDormant(reason: string): void {
    if (this.dormant) return;
    this.dormant = true;
    this.log.warn(
      {
        instance: this.instanceUrl,
        reason,
        attempts: this.failures,
        nextAttemptMs: OwncastChatListener.DORMANT_INTERVAL_MS,
      },
      'owncast chat unreachable — backing off to slow re-probe'
    );
  }

  private arm(delayMs: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
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

  private scheduleReconnect({ countAsFailure = true } = {}): void {
    if (this.stopped || this.reconnectTimer) return;
    if (countAsFailure) this.failures += 1;
    if (this.failures >= OwncastChatListener.MAX_CONSECUTIVE_FAILURES) {
      this.goDormant(`${this.failures} consecutive connection failures`);
    }
    if (this.dormant) {
      this.arm(OwncastChatListener.DORMANT_INTERVAL_MS);
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      OwncastChatListener.MAX_RECONNECT_DELAY_MS
    );
    this.log.info({ instance: this.instanceUrl, delayMs: delay }, 'owncast chat reconnect scheduled');
    this.arm(delay);
  }
}
