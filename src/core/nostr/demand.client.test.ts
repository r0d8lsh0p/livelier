/**
 * Unit tests for DemandClient with global fetch mocked. The parse contract:
 * collect every `#a` value from entries with active > 0, ignore the rest.
 */
import { DemandClient } from './demand.client';

const demandResponse = (demand: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ demand }),
  }) as Response;

describe('DemandClient', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    global.fetch = fetchMock as never;
  });
  afterEach(() => jest.clearAllMocks());

  it('collects #a values from active entries only', async () => {
    fetchMock.mockResolvedValue(
      demandResponse([
        { filter: { kinds: [1311, 9735], '#a': ['30311:pk:room-a'] }, active: 3 },
        { filter: { kinds: [1311], '#a': ['30311:pk:room-b', '30311:pk:room-c'] }, active: 1 },
        { filter: { kinds: [1311], '#a': ['30311:pk:room-gone'] }, active: 0 },
        { filter: { kinds: [1311] }, active: 5 }, // firehose-style, no #a
      ])
    );
    const client = new DemandClient('http://relay:3335/demand', null);
    const aTags = await client.fetchDemandedATags();
    expect([...aTags].sort()).toEqual(['30311:pk:room-a', '30311:pk:room-b', '30311:pk:room-c']);
  });

  it('sends the bearer token when configured', async () => {
    fetchMock.mockResolvedValue(demandResponse([]));
    const client = new DemandClient('http://relay:3335/demand', 'sekrit');
    await client.fetchDemandedATags();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://relay:3335/demand',
      expect.objectContaining({ headers: { Authorization: 'Bearer sekrit' } })
    );
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);
    const client = new DemandClient('http://relay:3335/demand', null);
    await expect(client.fetchDemandedATags()).rejects.toThrow('401');
  });

  it('tolerates a missing/malformed demand array', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const client = new DemandClient('http://relay:3335/demand', null);
    await expect(client.fetchDemandedATags()).resolves.toEqual(new Set());
  });
});
