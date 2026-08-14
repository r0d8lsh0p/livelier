import { getDefaultReadRelays, getDefaultWriteRelays, getProfileRelays, RelayList } from '../relay-utils';
import { RelayService } from './relay.service';

describe('RelayService', () => {
  it('getProfileRelays returns the dedicated profile relay set, unmerged', () => {
    const relayService = new RelayService();
    expect(relayService.getProfileRelays()).toEqual([...getProfileRelays()]);
  });

  it('getProfileFallbackRelays is the read set minus the profile relays', () => {
    const relayService = new RelayService();
    const userRelays: RelayList = {
      read: ['wss://user.custom.relay'],
      write: [],
    };

    const fallback = relayService.getProfileFallbackRelays(userRelays);
    const profileSet = new Set(getProfileRelays());

    // A user-configured relay must be part of the fallback ask — profiles
    // that live only there must never be negative-cached unseen.
    expect(fallback).toContain('wss://user.custom.relay');
    fallback.forEach((url) => {
      expect(profileSet.has(url)).toBe(false);
    });
  });

  it('falls back to default read relays when none are provided', () => {
    const relayService = new RelayService();
    expect(relayService.getReadRelays()).toEqual(getDefaultReadRelays());
  });

  it('falls back to default write relays when none are provided', () => {
    const relayService = new RelayService();
    expect(relayService.getWriteRelays()).toEqual(getDefaultWriteRelays());
  });

  it('merges explicit user read relays with the defaults', () => {
    const relayService = new RelayService();
    const userRelays: RelayList = { read: ['wss://user.read.relay'], write: [] };
    const relays = relayService.getReadRelays(userRelays);
    expect(relays).toContain('wss://user.read.relay');
    getDefaultReadRelays().forEach((url) => expect(relays).toContain(url));
  });
});
