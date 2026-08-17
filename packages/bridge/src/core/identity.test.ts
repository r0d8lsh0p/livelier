import { bridgeSignerFrom, dTagFor, instanceSigner, profileHash } from './identity';

describe('dTagFor', () => {
  it('is deterministic, unique per instance, and under 30 chars (nostrlib #a index limit)', () => {
    const a = dTagFor('https://stream.example.com:8080/', 'oc');
    expect(a).toBe(dTagFor('https://stream.example.com:8080', 'oc'));
    expect(a).toMatch(/^oc-[0-9a-f]{16}$/);
    expect(a.length).toBeLessThan(30);
    expect(a).not.toBe(dTagFor('https://other.example.com', 'oc'));
  });

  it('prefixes per source so two networks never share a coordinate', () => {
    const url = 'https://stream.example.com';
    expect(dTagFor(url, 'oc')).not.toBe(dTagFor(url, 'pt'));
    expect(dTagFor(url, 'pt')).toMatch(/^pt-[0-9a-f]{16}$/);
  });
});

describe('instanceSigner', () => {
  it('is deterministic per (url, secret, source) and namespaced by source', () => {
    const a = instanceSigner('https://live.example', 'secret', 'owncast');
    const b = instanceSigner('https://live.example', 'secret', 'owncast');
    expect(a.getPublicKey()).toBe(b.getPublicKey());
    // A different source yields a different identity for the same URL.
    const other = instanceSigner('https://live.example', 'secret', 'peertube');
    expect(other.getPublicKey()).not.toBe(a.getPublicKey());
  });
});

describe('bridgeSignerFrom', () => {
  it('derives from the key secret when no nsec is set', () => {
    const a = bridgeSignerFrom({ bridgeNsec: null, bridgeKeySecret: 'secret' });
    const b = bridgeSignerFrom({ bridgeNsec: null, bridgeKeySecret: 'secret' });
    expect(a.getPublicKey()).toBe(b.getPublicKey());
  });

  it('rejects a non-nsec BRIDGE_NSEC', () => {
    expect(() =>
      bridgeSignerFrom({
        bridgeNsec: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        bridgeKeySecret: 'secret',
      })
    ).toThrow();
  });
});

describe('profileHash', () => {
  it('is stable and content-sensitive', () => {
    expect(profileHash('abc')).toBe(profileHash('abc'));
    expect(profileHash('abc')).not.toBe(profileHash('abd'));
    expect(profileHash('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});
