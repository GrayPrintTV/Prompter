import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';
import { runtimeSettingsFromDisplay } from '../../shared/protocol/runtime-settings';

describe('tablet runtime settings', () => {
  it('maps Windows typography and text width to calibrated tablet presentation values', () => {
    const settings = runtimeSettingsFromDisplay({ ...DEFAULT_DISPLAY_SETTINGS, fontSizePx: 34 }, 3, 100);
    expect(settings.display.fontSizeSp).toBe(34.6);
    expect(settings.display.contentWidthFraction).toBe(.705);
    expect(settings.display.readingBandFraction).toBe(.38);
  });

  it('makes Windows text width visibly monotonic on a tablet viewport', () => {
    const narrow = runtimeSettingsFromDisplay({ ...DEFAULT_DISPLAY_SETTINGS, textWidthCh: 42 }, 3, 100);
    const wide = runtimeSettingsFromDisplay({ ...DEFAULT_DISPLAY_SETTINGS, textWidthCh: 92 }, 4, 100);
    expect(narrow.display.contentWidthFraction).toBe(.52);
    expect(wide.display.contentWidthFraction).toBe(.94);
  });

  it('preserves the Windows palette and follow policy in the effective snapshot settings', () => {
    const settings = runtimeSettingsFromDisplay({ ...DEFAULT_DISPLAY_SETTINGS, backgroundColor: '#000000', tabletLargeCorrectionPolicy: 'snap' }, 4, 101);
    expect(settings).toMatchObject({ settingsRevision: 4, source: 'windows', display: { backgroundColor: '#000000' }, follow: { largeCorrectionPolicy: 'snap' } });
  });
});
