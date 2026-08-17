import {
  processMessageForDisplay,
  formatZapReceipt,
  formatReaction,
  processContent,
  getProfilePubkey,
} from './content-processor';

/**
 * Regression (issue #1198): `utils/content-processor.ts` is a SELECTIVE
 * re-export barrel that shadows the `content-processor/` directory (file
 * beats index.ts in module resolution). A function added to the directory's
 * index but not to this list is silently `undefined` for every consumer
 * importing '../utils/content-processor' — jest missed it because component
 * tests mock the consuming hook. This test imports through the barrel and
 * EXECUTES the exports.
 */
describe('content-processor barrel re-exports', () => {
  it('re-exports callable functions', () => {
    expect(typeof processMessageForDisplay).toBe('function');
    expect(typeof formatZapReceipt).toBe('function');
    expect(typeof formatReaction).toBe('function');
    expect(typeof processContent).toBe('function');
    expect(typeof getProfilePubkey).toBe('function');
  });

  it('processMessageForDisplay dispatches by kind through the barrel', async () => {
    const reaction = await processMessageForDisplay({
      id: 'r1',
      kind: 7,
      pubkey: 'sender',
      content: '+',
      created_at: 1,
      tags: [['p', 'user']],
    });
    expect(reaction.text).toBe('👍');

    const zap = await processMessageForDisplay({
      id: 'z1',
      kind: 9735,
      pubkey: 'wallet',
      content: '',
      created_at: 1,
      tags: [
        ['p', 'user'],
        ['description', JSON.stringify({ tags: [['amount', '21000']] })],
      ],
    });
    expect(zap.text).toContain('21 sats');
  });

  it('surfaces the zap comment from the embedded zap request (rc5 regression)', async () => {
    // Most LNURL servers publish the 9735 receipt with EMPTY content; the
    // user's comment only exists inside the description-tag zap request.
    const zap = await processMessageForDisplay({
      id: 'z2',
      kind: 9735,
      pubkey: 'wallet',
      content: '',
      created_at: 1,
      tags: [
        ['p', 'user'],
        [
          'description',
          JSON.stringify({ kind: 9734, tags: [['amount', '2121000']], content: 'Great live!' }),
        ],
      ],
    });
    expect(zap.text).toBe('Zapped 2121 sats: Great live!');
  });
});
