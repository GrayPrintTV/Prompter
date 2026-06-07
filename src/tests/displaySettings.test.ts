import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
  resolveInitialDisplaySettings
} from '../state/appStore';

describe('display settings startup defaults', () => {
  it('uses the narration reading-band default for fresh sessions', () => {
    const settings = resolveInitialDisplaySettings();

    expect(settings.readingZonePercent).toBe(38);
    expect(settings.showActiveHighlight).toBe(false);
  });

  it('preserves saved reading-zone settings after migration has already run', () => {
    const settings = resolveInitialDisplaySettings({
      readingZonePercent: 62,
      showActiveHighlight: true
    });

    expect(settings.readingZonePercent).toBe(62);
    expect(settings.showActiveHighlight).toBe(true);
  });

  it('migrates old bottom-half narration settings to the higher band once', () => {
    const settings = resolveInitialDisplaySettings(
      {
        readingZonePercent: 62,
        showActiveHighlight: true
      },
      { migrateLegacyNarrationDefaults: true }
    );

    expect(settings.readingZonePercent).toBe(DEFAULT_DISPLAY_SETTINGS.readingZonePercent);
    expect(settings.showActiveHighlight).toBe(DEFAULT_DISPLAY_SETTINGS.showActiveHighlight);
  });

  it('keeps saved top-half reading-zone settings during the migration', () => {
    const settings = resolveInitialDisplaySettings(
      {
        readingZonePercent: 42,
        showActiveHighlight: true
      },
      { migrateLegacyNarrationDefaults: true }
    );

    expect(settings.readingZonePercent).toBe(42);
    expect(settings.showActiveHighlight).toBe(DEFAULT_DISPLAY_SETTINGS.showActiveHighlight);
  });
});
