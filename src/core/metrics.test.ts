import { anyRelayAccepted, newCycleMetrics } from './metrics';

describe('anyRelayAccepted', () => {
  it('is true when any relay reported success', () => {
    expect(anyRelayAccepted({ 'ws://a': false, 'ws://b': true })).toBe(true);
  });
  it('is false when all failed or empty', () => {
    expect(anyRelayAccepted({ 'ws://a': false })).toBe(false);
    expect(anyRelayAccepted({})).toBe(false);
  });
});

describe('newCycleMetrics', () => {
  it('starts zeroed with directoryOk false', () => {
    const m = newCycleMetrics();
    expect(m.directoryOk).toBe(false);
    expect(m.liveInDirectory).toBe(0);
    expect(m.published30311).toBe(0);
  });
});
