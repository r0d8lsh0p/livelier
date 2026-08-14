import { initAppConfig, getAppConfig, type AppConfig } from './app-config';

afterEach(() => {
  initAppConfig();
});

describe('app-config', () => {
  describe('defaults', () => {
    it('returns default relay lists without calling initAppConfig()', () => {
      const config = getAppConfig();
      expect(config.defaultReadRelays.length).toBeGreaterThan(0);
      expect(config.defaultWriteRelays.length).toBeGreaterThan(0);
      // purplepag.es is a profile-specialty relay: profileRelays only, never
      // the general read set (it rejects REQs without a kinds filter).
      expect(config.defaultReadRelays).not.toContain('wss://purplepag.es');
      expect(config.profileRelays).toContain('wss://purplepag.es');
    });
  });

  describe('initAppConfig()', () => {
    it('resets to defaults when called with no args', () => {
      initAppConfig({ profileRelays: ['wss://override.example'] });
      expect(getAppConfig().profileRelays).toEqual(['wss://override.example']);

      initAppConfig();
      expect(getAppConfig().profileRelays).toContain('wss://purplepag.es');
    });

    it('overrides only the provided keys', () => {
      const before = getAppConfig();
      initAppConfig({ defaultReadRelays: ['wss://read.example'] });
      const after = getAppConfig();
      expect(after.defaultReadRelays).toEqual(['wss://read.example']);
      expect(after.defaultWriteRelays).toEqual(before.defaultWriteRelays);
      expect(after.profileRelays).toEqual(before.profileRelays);
    });

    it('ignores undefined values in overrides', () => {
      const before = getAppConfig().defaultReadRelays;
      initAppConfig({ defaultReadRelays: undefined } as Partial<AppConfig>);
      expect(getAppConfig().defaultReadRelays).toEqual(before);
    });

    it('getAppConfig reflects the live config object after re-init', () => {
      initAppConfig({ defaultWriteRelays: ['wss://write.example'] });
      expect(getAppConfig().defaultWriteRelays).toEqual(['wss://write.example']);
    });
  });
});
