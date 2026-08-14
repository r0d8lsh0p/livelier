/**
 * The two-tier replaceable-event loader is the core of every profile
 * lookup. Constructed directly with stub query functions — no network.
 */
import type { Event } from 'nostr-tools';
import { ReplaceableEventLoader } from './client.service';

const ev = (kind: number, pubkey: string, created = 1000): Event => ({
  id: 'e'.repeat(64),
  pubkey,
  kind,
  created_at: created,
  content: '{}',
  sig: 's'.repeat(128),
  tags: [],
});

const pk = (n: number) => n.toString(16).padStart(64, '0');

describe('ReplaceableEventLoader', () => {
  it('fallback receives only the keys the primary tier missed', async () => {
    const found = ev(10002, pk(1));
    const primary = jest.fn().mockResolvedValue({ events: [found], eoseCount: 1 });
    const fallback = jest.fn().mockResolvedValue({ events: [], eoseCount: 1 });
    const loader = new ReplaceableEventLoader(primary, {
      batchDelay: 1,
      fallbackQueryFn: fallback,
    });

    const [a, b] = await Promise.all([
      loader.load({ pubkey: pk(1), kind: 10002 }),
      loader.load({ pubkey: pk(2), kind: 10002 }),
    ]);

    expect(a).toEqual(found);
    expect(b).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    const fallbackAuthors = fallback.mock.calls[0][0].flatMap(
      (f: { authors: string[] }) => f.authors
    );
    expect(fallbackAuthors).toEqual([pk(2)]);
  });

  it('negative-caches a genuine miss (eoseCount > 0) — no refetch on the next load', async () => {
    const primary = jest.fn().mockResolvedValue({ events: [], eoseCount: 2 });
    const loader = new ReplaceableEventLoader(primary, { batchDelay: 1 });

    await expect(loader.load({ pubkey: pk(3), kind: 10002 })).resolves.toBeUndefined();
    expect(primary).toHaveBeenCalledTimes(1);

    await expect(loader.load({ pubkey: pk(3), kind: 10002 })).resolves.toBeUndefined();
    expect(primary).toHaveBeenCalledTimes(1); // served from the miss ledger
  });

  it('an unanswered miss (eoseCount 0) stays retryable', async () => {
    const primary = jest.fn().mockResolvedValue({ events: [], eoseCount: 0 });
    const loader = new ReplaceableEventLoader(primary, { batchDelay: 1 });

    await loader.load({ pubkey: pk(4), kind: 10002 });
    await loader.load({ pubkey: pk(4), kind: 10002 });
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it('kind 0 is exempt from the miss ledger (the coordinator owns profile retries)', async () => {
    const primary = jest.fn().mockResolvedValue({ events: [], eoseCount: 2 });
    const loader = new ReplaceableEventLoader(primary, { batchDelay: 1 });

    await loader.load({ pubkey: pk(5), kind: 0 });
    await loader.load({ pubkey: pk(5), kind: 0 });
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it('prime() installs an event and clears a recorded miss', async () => {
    const primary = jest.fn().mockResolvedValue({ events: [], eoseCount: 1 });
    const loader = new ReplaceableEventLoader(primary, { batchDelay: 1 });

    await loader.load({ pubkey: pk(6), kind: 10002 });
    const primed = ev(10002, pk(6), 2000);
    loader.prime(primed);
    await expect(loader.load({ pubkey: pk(6), kind: 10002 })).resolves.toEqual(primed);
    expect(primary).toHaveBeenCalledTimes(1); // second load came from cache
  });
});
