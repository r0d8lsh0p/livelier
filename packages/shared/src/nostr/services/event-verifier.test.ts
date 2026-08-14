import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools';
import {
  cachedVerifyEvent,
  getVerifyStats,
  markEventVerified,
  resetVerifyStats
} from './event-verifier';

function makeSignedEvent(content = 'hello'): Event {
  const sk = generateSecretKey();
  const signed = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content },
    sk
  );
  // Rebuild as a plain object: finalizeEvent stamps nostr-tools'
  // verifiedSymbol, which object spread copies and verifyEvent short-circuits
  // on. Events arriving from relays are parsed JSON and never carry it.
  return {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig
  };
}

describe('cachedVerifyEvent', () => {
  beforeEach(() => {
    resetVerifyStats();
  });

  it('verifies a valid event with a full Schnorr check on first sight', () => {
    const event = makeSignedEvent();
    expect(cachedVerifyEvent(event)).toBe(true);
    const stats = getVerifyStats();
    expect(stats.schnorrCount).toBe(1);
    expect(stats.cacheHits).toBe(0);
  });

  it('skips Schnorr on a repeat sighting of the same event ID', () => {
    const event = makeSignedEvent();
    expect(cachedVerifyEvent(event)).toBe(true);
    // Same event delivered again (e.g. by another relay or a reconnect replay).
    expect(cachedVerifyEvent({ ...event })).toBe(true);
    const stats = getVerifyStats();
    expect(stats.schnorrCount).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });

  it('trusts a cached ID outright without re-verifying (Amethyst/Jumble model)', () => {
    // A replayed known ID passes the verifier with no crypto at all. The
    // guard against tampered replays is store-level: every store dedupes by
    // event ID and keeps the first-seen copy, so a later copy never renders.
    const event = makeSignedEvent();
    expect(cachedVerifyEvent(event)).toBe(true);
    const replayed = { ...event, content: 'different bytes, same id' };
    expect(cachedVerifyEvent(replayed)).toBe(true);
    const stats = getVerifyStats();
    expect(stats.schnorrCount).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });

  it('rejects an invalid signature and does not cache the ID', () => {
    const event = makeSignedEvent();
    const badSig = { ...event, sig: event.sig.replace(/^../, event.sig.startsWith('00') ? '11' : '00') };
    expect(cachedVerifyEvent(badSig)).toBe(false);
    // The untampered event must still require (and pass) a real verify.
    expect(cachedVerifyEvent(event)).toBe(true);
    const stats = getVerifyStats();
    expect(stats.schnorrCount).toBe(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('rejects malformed events on shape alone', () => {
    const event = makeSignedEvent();
    expect(cachedVerifyEvent({ ...event, id: 'short' })).toBe(false);
    expect(cachedVerifyEvent({ ...event, sig: 'short' })).toBe(false);
    expect(getVerifyStats().schnorrCount).toBe(0);
  });

  it('markEventVerified lets self-published events skip Schnorr on relay echo', () => {
    const event = makeSignedEvent();
    markEventVerified(event.id);
    expect(cachedVerifyEvent(event)).toBe(true);
    const stats = getVerifyStats();
    expect(stats.schnorrCount).toBe(0);
    expect(stats.cacheHits).toBe(1);
  });
});
