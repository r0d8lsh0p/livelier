import { getZapReceiptAmountSats, getZapReceiptMessage, formatAmount } from './lightning-utils';

describe('getZapReceiptAmountSats', () => {
  it('reads the amount from the embedded zap request (description tag)', () => {
    const tags = [
      ['p', 'recipient'],
      ['description', JSON.stringify({ tags: [['amount', '21000']] })],
    ];
    expect(getZapReceiptAmountSats(tags)).toBe(21);
  });

  it('falls back to a direct amount tag (millisats)', () => {
    expect(getZapReceiptAmountSats([['amount', '5000']])).toBe(5);
  });

  it('survives a malformed description and returns 0 with no amount source', () => {
    expect(getZapReceiptAmountSats([['description', 'not-json']])).toBe(0);
    expect(getZapReceiptAmountSats([])).toBe(0);
  });
});

describe('getZapReceiptMessage', () => {
  // Real receipt from the wild (nevent1qqsrml2jykh3txffnm7avfmnzdasp0y2ff
  // 380pz9k4mjhn3465zj70cstxcyy): empty receipt content, comment only in
  // the embedded zap request — the shape most LNURL servers publish.
  const realDescription = JSON.stringify({
    id: '15d7296663aa85ad19f6bb5b4cdab0cb0b50ee5076e6cd5271284ded4110f361',
    pubkey: '1bda7e1f7396bda2d1ef99033da8fd2dc362810790df9be62f591038bb97c4d9',
    created_at: 1784802634,
    kind: 9734,
    tags: [
      ['p', '332c0f0420e334c7d240d9db97573c27a75cf5df2db40a227a1a6b8765ba567d'],
      ['amount', '2121000'],
      ['lnurl', 'Gaminglife@rizful.com'],
      ['client', 'Wisp'],
    ],
    content: 'Great live!',
  });

  it('reads the comment from the embedded zap request (empty receipt content)', () => {
    expect(getZapReceiptMessage([['description', realDescription]], '')).toBe('Great live!');
  });

  it('prefers the zap request comment over a differing receipt content', () => {
    expect(getZapReceiptMessage([['description', realDescription]], 'server copy')).toBe(
      'Great live!',
    );
  });

  it('falls back to receipt content when the request has no comment', () => {
    const noComment = JSON.stringify({ kind: 9734, tags: [], content: '' });
    expect(getZapReceiptMessage([['description', noComment]], 'from receipt')).toBe(
      'from receipt',
    );
  });

  it('falls back to receipt content when the description is malformed', () => {
    expect(getZapReceiptMessage([['description', 'not-json']], 'from receipt')).toBe(
      'from receipt',
    );
  });

  it('returns empty when neither source has a comment', () => {
    expect(getZapReceiptMessage([], '')).toBe('');
    expect(getZapReceiptMessage([['description', 'not-json']], '')).toBe('');
  });
});

describe('formatAmount', () => {
  it('formats sats compactly', () => {
    expect(formatAmount(999)).toBe('999');
    expect(formatAmount(1500)).toBe('1.5k');
  });
});
