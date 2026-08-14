import { deriveBridgeIdentityKey, deriveInstancePrivKey, normalizeInstanceUrl } from './bridge-key';
import { DerivedKeySigner } from './signers/derived-key.signer';
import { getPublicKey, verifyEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

describe('normalizeInstanceUrl', () => {
  it('lowercases host, strips trailing slash, drops query/fragment', () => {
    expect(normalizeInstanceUrl('https://Silo.FFMUC.net/?x=1#f')).toBe('https://silo.ffmuc.net');
  });

  it('treats trailing-slash and non-slash variants identically', () => {
    expect(normalizeInstanceUrl('https://a.example/')).toBe(normalizeInstanceUrl('https://a.example'));
  });

  it('preserves a non-default port and path', () => {
    expect(normalizeInstanceUrl('http://a.example:8080/live/')).toBe('http://a.example:8080/live');
  });
});

describe('deriveInstancePrivKey', () => {
  const secret = 'test-secret';

  it('is deterministic for the same url + secret', () => {
    const a = deriveInstancePrivKey('https://a.example', secret);
    const b = deriveInstancePrivKey('https://a.example', secret);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a.length).toBe(32);
  });

  it('is stable across URL spelling differences that normalise equal', () => {
    const a = deriveInstancePrivKey('https://A.example/', secret);
    const b = deriveInstancePrivKey('https://a.example', secret);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('differs for different urls', () => {
    const a = deriveInstancePrivKey('https://a.example', secret);
    const b = deriveInstancePrivKey('https://b.example', secret);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('differs for different secrets (re-keys the whole namespace)', () => {
    const a = deriveInstancePrivKey('https://a.example', 'secret-1');
    const b = deriveInstancePrivKey('https://a.example', 'secret-2');
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('differs across namespaces (domain separation)', () => {
    const a = deriveInstancePrivKey('https://a.example', secret, 'owncast');
    const b = deriveInstancePrivKey('https://a.example', secret, 'other');
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('rejects an empty secret', () => {
    expect(() => deriveInstancePrivKey('https://a.example', '')).toThrow();
  });
});

describe('deriveBridgeIdentityKey', () => {
  it('is deterministic and 32 bytes', () => {
    const a = deriveBridgeIdentityKey('test-secret');
    const b = deriveBridgeIdentityKey('test-secret');
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a.length).toBe(32);
  });

  it('never collides with any derived instance key (separate namespace)', () => {
    const bridge = deriveBridgeIdentityKey('test-secret');
    const instance = deriveInstancePrivKey('https://self', 'test-secret');
    expect(bytesToHex(bridge)).not.toBe(bytesToHex(instance));
  });

  it('rejects an empty secret', () => {
    expect(() => deriveBridgeIdentityKey('')).toThrow();
  });
});

describe('DerivedKeySigner', () => {
  const priv = deriveInstancePrivKey('https://a.example', 'test-secret');

  it('derives the matching public key (hex and Uint8Array inputs agree)', () => {
    const fromBytes = new DerivedKeySigner(priv);
    const fromHex = new DerivedKeySigner(bytesToHex(priv));
    expect(fromBytes.getPublicKey()).toBe(getPublicKey(priv));
    expect(fromHex.getPublicKey()).toBe(fromBytes.getPublicKey());
  });

  it('signs a valid, verifiable event', () => {
    const signer = new DerivedKeySigner(priv);
    const signed = signer.signEvent({
      kind: 30311,
      content: '',
      tags: [['d', 'x']],
      created_at: 1700000000,
    });
    expect(signed.pubkey).toBe(signer.getPublicKey());
    expect(verifyEvent(signed)).toBe(true);
  });

  it('rejects a wrong-length key', () => {
    expect(() => new DerivedKeySigner(new Uint8Array(16))).toThrow();
  });
});
