import WebSocket from 'ws';
import type { Event } from 'nostr-tools';
import { DerivedKeySigner } from '../../../shared/src/nostr/signers/derived-key.signer';

/**
 * One-shot NIP-42-authenticated publish. NIP-42 auth is a per-connection
 * property, so a bridge multiplexing many chatter authors cannot auth them on
 * one shared socket — instead each write gets its own short-lived connection:
 * connect, publish, answer the AUTH challenge as the EVENT'S AUTHOR (the
 * bridge holds every chatter key), republish, close.
 *
 * Relays that never demand auth resolve on the first OK; the challenge path
 * only engages on "auth-required:" rejections (the strict relay's NIP-70
 * policy for '-'-tagged events).
 */
export function publishAuthed(
  relayUrl: string,
  signer: DerivedKeySigner,
  event: Event,
  timeoutMs: number = 10_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    let challenge: string | null = null;
    let authSent = false;
    let authEventId: string | null = null;
    let eventResent = false;
    let settled = false;

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => settle(new Error('authed publish timeout')), timeoutMs);

    const resendEvent = (): void => {
      if (eventResent || settled) return;
      eventResent = true;
      ws.send(JSON.stringify(['EVENT', event]));
    };

    const sendAuth = (): void => {
      if (!challenge || authSent) return;
      authSent = true;
      const authEvent = signer.signEvent({
        kind: 22242,
        content: '',
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['relay', relayUrl],
          ['challenge', challenge],
        ],
      });
      authEventId = authEvent.id;
      ws.send(JSON.stringify(['AUTH', authEvent]));
      // The EVENT is resent only after the relay ACKs the AUTH (its OK for
      // the 22242) — sending both back-to-back races the relay's auth
      // registration and intermittently re-rejects. Fallback timer covers
      // relays that never ACK an AUTH (NIP-42 says SHOULD, not MUST).
      setTimeout(resendEvent, 1500);
    };

    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(data.toString()) as unknown[];
      } catch {
        return;
      }
      if (msg[0] === 'AUTH' && typeof msg[1] === 'string') {
        challenge = msg[1];
        return;
      }
      if (msg[0] === 'OK' && authEventId && msg[1] === authEventId) {
        if (msg[2] === true) resendEvent();
        else settle(new Error(`relay rejected AUTH: ${typeof msg[3] === 'string' ? msg[3] : ''}`));
        return;
      }
      if (msg[0] !== 'OK' || msg[1] !== event.id) return;
      const accepted = msg[2] === true;
      const reason = typeof msg[3] === 'string' ? msg[3] : '';
      if (accepted) return settle();
      if (reason.startsWith('auth-required:') && !authSent) {
        // khatru sends the challenge on connect; if it raced past us, wait —
        // the AUTH handler above will not fire sendAuth twice.
        if (challenge) sendAuth();
        else {
          const authWait = setInterval(() => {
            if (challenge) {
              clearInterval(authWait);
              sendAuth();
            }
          }, 50);
          setTimeout(() => clearInterval(authWait), timeoutMs);
        }
        return;
      }
      settle(new Error(`relay rejected kind ${event.kind} event: ${reason || 'no reason'}`));
    });
    ws.on('error', (err) => settle(new Error(`authed publish socket error: ${err.message}`)));
  });
}
