import {
  NETWORK_CHAT_READ_RELAYS,
  NETWORK_PROFILE_WRITE_RELAYS,
  networkChatReadRelays,
  profileWriteRelays,
} from './relays';

const CHAT = 'ws://ephemeral-relay:3335';

const allOff = {
  chatRelayUrl: CHAT,
  networkProfilePublishEnabled: false,
  networkChatReadEnabled: false,
  networkProfileWriteRelays: NETWORK_PROFILE_WRITE_RELAYS,
  networkChatReadRelays: NETWORK_CHAT_READ_RELAYS,
};

describe('relay sets', () => {
  it('are frozen and valid websocket URLs', () => {
    for (const set of [NETWORK_PROFILE_WRITE_RELAYS, NETWORK_CHAT_READ_RELAYS]) {
      expect(Object.isFrozen(set)).toBe(true);
      for (const url of set) expect(url).toMatch(/^wss:\/\//);
    }
    expect(NETWORK_PROFILE_WRITE_RELAYS).toContain('wss://purplepag.es');
  });
});

describe('both flags off (staging/local posture)', () => {
  it('WRITES touch only the bridge chat relay; no network chat reads', () => {
    expect(profileWriteRelays(allOff)).toEqual([CHAT]);
    expect(networkChatReadRelays(allOff)).toEqual([]);
  });
});

describe('flags are independent', () => {
  it('publish gate alone widens ONLY the write set', () => {
    const publishOnly = { ...allOff, networkProfilePublishEnabled: true };
    expect(profileWriteRelays(publishOnly)).toEqual([CHAT, ...NETWORK_PROFILE_WRITE_RELAYS]);
    expect(networkChatReadRelays(publishOnly)).toEqual([]);
  });

  it('chat-read gate alone widens ONLY the read set, never duplicating the chat relay', () => {
    const readOnly = { ...allOff, networkChatReadEnabled: true };
    expect(profileWriteRelays(readOnly)).toEqual([CHAT]);
    expect(networkChatReadRelays(readOnly)).toEqual([...NETWORK_CHAT_READ_RELAYS]);
    expect(
      networkChatReadRelays({ ...readOnly, chatRelayUrl: NETWORK_CHAT_READ_RELAYS[0] })
    ).toEqual(NETWORK_CHAT_READ_RELAYS.slice(1));
  });

  it('honours env-overridden sets (test WRITES point at local dummies)', () => {
    const dummies = {
      ...allOff,
      networkProfilePublishEnabled: true,
      networkChatReadEnabled: true,
      networkProfileWriteRelays: ['ws://dummy-purple:7460'],
      networkChatReadRelays: ['ws://dummy-net:7461'],
    };
    expect(profileWriteRelays(dummies)).toEqual([CHAT, 'ws://dummy-purple:7460']);
    expect(networkChatReadRelays(dummies)).toEqual(['ws://dummy-net:7461']);
  });
});
