/**
 * publishAuthed against an in-process ws server playing the khatru NIP-42
 * flow: challenge on connect, "auth-required:" until an AUTH signed by the
 * event author arrives, accept after.
 */
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { verifyEvent, type Event } from 'nostr-tools';
import { publishAuthed } from './authed-publish';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';

type RelayBehaviour = 'open' | 'nip70' | 'nip70-async-auth' | 'reject';

async function startFakeRelay(behaviour: RelayBehaviour) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const state = { authedAs: new Map<unknown, string>(), authEvents: [] as Event[] };
  const isNip70 = behaviour === 'nip70' || behaviour === 'nip70-async-auth';
  wss.on('connection', (socket) => {
    if (isNip70) socket.send(JSON.stringify(['AUTH', 'challenge-123']));
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'AUTH') {
        state.authEvents.push(msg[1]);
        // The khatru race publishAuthed must survive: auth registration (and
        // its OK) lands a beat AFTER the AUTH frame — a client that resends
        // its EVENT back-to-back with AUTH still hits "auth-required".
        const register = () => {
          state.authedAs.set(socket, msg[1].pubkey);
          socket.send(JSON.stringify(['OK', msg[1].id, true, '']));
        };
        behaviour === 'nip70-async-auth' ? setTimeout(register, 100) : register();
        return;
      }
      if (msg[0] !== 'EVENT') return;
      const event = msg[1];
      if (behaviour === 'reject') {
        socket.send(JSON.stringify(['OK', event.id, false, 'blocked: kind not allowed']));
        return;
      }
      if (isNip70 && state.authedAs.get(socket) !== event.pubkey) {
        socket.send(
          JSON.stringify(['OK', event.id, false, 'auth-required: must be published by authenticated event author'])
        );
        return;
      }
      socket.send(JSON.stringify(['OK', event.id, true, '']));
    });
  });
  const url = () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { wss, state, url, close: () => new Promise((r) => wss.close(r)) };
}

const signer = new DerivedKeySigner(new Uint8Array(crypto.randomBytes(32)));
const makeEvent = () =>
  signer.signEvent({
    kind: 1311,
    content: 'hello',
    created_at: Math.floor(Date.now() / 1000),
    tags: [['-']],
  });

describe('publishAuthed', () => {
  it('resolves immediately on an open relay (no auth demanded)', async () => {
    const relay = await startFakeRelay('open');
    await publishAuthed(relay.url(), signer, makeEvent(), 3000);
    expect(relay.state.authEvents).toHaveLength(0);
    await relay.close();
  });

  it('answers auth-required with a valid 22242 by the author, then lands the event', async () => {
    const relay = await startFakeRelay('nip70');
    const event = makeEvent();
    await publishAuthed(relay.url(), signer, event, 3000);
    expect(relay.state.authEvents).toHaveLength(1);
    const auth = relay.state.authEvents[0];
    expect(auth.kind).toBe(22242);
    expect(auth.pubkey).toBe(event.pubkey); // authed AS the event author
    expect(auth.tags).toContainEqual(['challenge', 'challenge-123']);
    expect(verifyEvent(auth)).toBe(true);
    await relay.close();
  });

  it('waits for the AUTH ack before resending — survives async auth registration', async () => {
    const relay = await startFakeRelay('nip70-async-auth');
    const event = makeEvent();
    await publishAuthed(relay.url(), signer, event, 3000);
    expect(relay.state.authEvents).toHaveLength(1);
    await relay.close();
  });

  it('rejects with the relay reason on a non-auth rejection', async () => {
    const relay = await startFakeRelay('reject');
    await expect(publishAuthed(relay.url(), signer, makeEvent(), 3000)).rejects.toThrow(
      'kind not allowed'
    );
    await relay.close();
  });

  it('times out against a black-hole relay', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    await expect(publishAuthed(url, signer, makeEvent(), 500)).rejects.toThrow('timeout');
    await new Promise((r) => wss.close(r));
  });
});
