import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
  resolveInitialDisplaySettings
} from '../state/appStore';

describe('display settings startup defaults', () => {
  it('uses the narration reading-band default for fresh sessions', () => {
    const settings = resolveInitialDisplaySettings();

    expect(settings.readingZonePercent).toBe(38);
    expect(settings.readingZoneHeightLines).toBe(1);
    expect(settings.showActiveHighlight).toBe(false);
    expect(settings.continuousAssistScroll).toBe(false);
    expect(settings.assistScrollSpeed).toBe(50);
    expect(settings.assistCorrectionFeel).toBe(45);
    expect(settings.readingLookaheadTokens).toBe(6);
  });

  it('preserves saved reading-zone settings after migration has already run', () => {
    const settings = resolveInitialDisplaySettings({
      readingZonePercent: 62,
      readingZoneHeightLines: 2.2,
      showActiveHighlight: true,
      assistScrollSpeed: 72,
      assistCorrectionFeel: 34
    });

    expect(settings.readingZonePercent).toBe(62);
    expect(settings.readingZoneHeightLines).toBe(2.2);
    expect(settings.showActiveHighlight).toBe(true);
    expect(settings.assistScrollSpeed).toBe(72);
    expect(settings.assistCorrectionFeel).toBe(34);
    // lookahead not provided, should get default
    expect(settings.readingLookaheadTokens).toBe(6);
  });

  it('fills and clamps newer assist-scroll display settings', () => {
    const settings = resolveInitialDisplaySettings({
      assistScrollSpeed: 400,
      assistCorrectionFeel: -8
    });

    expect(settings.assistScrollSpeed).toBe(100);
    expect(settings.assistCorrectionFeel).toBe(1);
  });

  it('fills and clamps Focus Bar height', () => {
    expect(
      resolveInitialDisplaySettings({ readingZoneHeightLines: 9 }).readingZoneHeightLines
    ).toBe(2.5);
    expect(
      resolveInitialDisplaySettings({ readingZoneHeightLines: 0.2 }).readingZoneHeightLines
    ).toBe(1);
    expect(
      resolveInitialDisplaySettings({ readingZoneHeightLines: Number.NaN }).readingZoneHeightLines
    ).toBe(DEFAULT_DISPLAY_SETTINGS.readingZoneHeightLines);
  });

  it('fills and clamps reading lookahead tokens', () => {
    const settings = resolveInitialDisplaySettings({
      readingLookaheadTokens: 99
    });
    expect(settings.readingLookaheadTokens).toBe(20);

    const settings2 = resolveInitialDisplaySettings({
      readingLookaheadTokens: -5
    });
    expect(settings2.readingLookaheadTokens).toBe(0);
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
