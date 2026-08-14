/**
 * loadConfig: required-env fail-fast, two-relay routing defaults, and the
 * per-source OWNCAST_* block.
 */
import { loadConfig } from './config';

const baseEnv = {
  BRIDGE_KEY_SECRET: 'secret',
  DATABASE_URL: 'postgres://x',
  LOCAL_RELAY_URL: 'ws://localhost:7447',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('throws listing every missing required var', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(
      'Missing required env: BRIDGE_KEY_SECRET, DATABASE_URL, LOCAL_RELAY_URL'
    );
  });

  it('accepts local, compose-service, and public relay URLs', () => {
    const { core } = loadConfig({
      ...baseEnv,
      EVENT_RELAY_URL: 'wss://event-relay.example',
      CHAT_RELAY_URL: 'ws://ephemeral-relay:3335',
    } as NodeJS.ProcessEnv);
    expect(core.eventRelayUrl).toBe('wss://event-relay.example');
    expect(core.chatRelayUrl).toBe('ws://ephemeral-relay:3335');
  });

  it('defaults both routing relays to LOCAL_RELAY_URL', () => {
    const { core } = loadConfig(baseEnv);
    expect(core.eventRelayUrl).toBe('ws://localhost:7447');
    expect(core.chatRelayUrl).toBe('ws://localhost:7447');
  });

  it('resolves chat expiration and demand settings with defaults', () => {
    const { core: defaults } = loadConfig(baseEnv);
    expect(defaults.chatExpirationSeconds).toBe(10_800);
    expect(defaults.demandUrl).toBeNull();
    expect(defaults.demandAuthToken).toBeNull();
    expect(defaults.demandPollIntervalMs).toBe(10_000);

    const { core: overridden } = loadConfig({
      ...baseEnv,
      CHAT_EXPIRATION_SECONDS: '600',
      DEMAND_URL: 'http://localhost:7448/demand',
      DEMAND_AUTH_TOKEN: 'tok',
      DEMAND_POLL_INTERVAL_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(overridden.chatExpirationSeconds).toBe(600);
    expect(overridden.demandUrl).toBe('http://localhost:7448/demand');
    expect(overridden.demandAuthToken).toBe('tok');
    expect(overridden.demandPollIntervalMs).toBe(5_000);
  });

  it('network gates: both default OFF and flip independently; env overrides the sets', () => {
    const { core: defaults } = loadConfig(baseEnv);
    expect(defaults.networkProfilePublishEnabled).toBe(false);
    expect(defaults.networkChatReadEnabled).toBe(false);
    expect(defaults.networkProfileWriteRelays).toContain('wss://purplepag.es');
    expect(defaults.networkChatReadRelays.length).toBeGreaterThan(0);

    const { core } = loadConfig({
      ...baseEnv,
      NETWORK_PROFILE_PUBLISH_ENABLED: 'true',
      NETWORK_PROFILE_WRITE_RELAYS: 'ws://dummy-purple:7460',
      NETWORK_CHAT_READ_RELAYS: 'ws://dummy-a:7461, ws://dummy-b:7462',
    } as NodeJS.ProcessEnv);
    expect(core.networkProfilePublishEnabled).toBe(true);
    expect(core.networkChatReadEnabled).toBe(false); // gates are independent
    expect(core.networkProfileWriteRelays).toEqual(['ws://dummy-purple:7460']);
    expect(core.networkChatReadRelays).toEqual(['ws://dummy-a:7461', 'ws://dummy-b:7462']);

    const { core: readOn } = loadConfig({
      ...baseEnv,
      NETWORK_CHAT_READ_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    expect(readOn.networkChatReadEnabled).toBe(true);
    expect(readOn.networkProfilePublishEnabled).toBe(false);
  });

  it('owncast block: enabled by default, gates and cadence from OWNCAST_* vars', () => {
    const { owncast: defaults } = loadConfig(baseEnv);
    expect(defaults.enabled).toBe(true);
    expect(defaults.discoveryEnabled).toBe(true);
    expect(defaults.directoryUrl).toBe('https://owncast.directory/api/home');
    expect(defaults.pollIntervalMs).toBe(60_000);
    expect(defaults.republishIntervalMs).toBe(15 * 60_000);
    expect(defaults.hlsTimeoutMs).toBe(10_000);
    expect(defaults.maxConsecutiveFailures).toBe(3);
    expect(defaults.chatToNostr).toBe(false);
    expect(defaults.chatFromNostr).toBe(false);
    // New-row posture: discovery on, chat off — matching pre-flag behavior.
    expect(defaults.defaultDiscoveryEnabled).toBe(true);
    expect(defaults.defaultChatEnabled).toBe(false);

    const { owncast } = loadConfig({
      ...baseEnv,
      OWNCAST_ENABLED: 'false',
      OWNCAST_DISCOVERY_ENABLED: 'false',
      OWNCAST_DIRECTORY_URL: 'http://localhost:9999/api/home',
      OWNCAST_POLL_INTERVAL_MS: '5000',
      OWNCAST_CHAT_TO_NOSTR: 'true',
      OWNCAST_CHAT_FROM_NOSTR: 'true',
      OWNCAST_DEFAULT_DISCOVERY_ENABLED: 'false',
      OWNCAST_DEFAULT_CHAT_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    expect(owncast.enabled).toBe(false);
    expect(owncast.discoveryEnabled).toBe(false);
    expect(owncast.directoryUrl).toBe('http://localhost:9999/api/home');
    expect(owncast.pollIntervalMs).toBe(5000);
    expect(owncast.chatToNostr).toBe(true);
    expect(owncast.chatFromNostr).toBe(true);
    expect(owncast.defaultDiscoveryEnabled).toBe(false);
    expect(owncast.defaultChatEnabled).toBe(true);
  });
});
