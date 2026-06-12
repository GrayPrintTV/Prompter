import type { DisplaySettings, LocalWhisperSettings } from '../domain/types';

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  fontFamily: 'Georgia, Cambria, "Times New Roman", serif',
  fontSizePx: 34,
  lineHeight: 1.55,
  textWidthCh: 64,
  paragraphSpacingEm: 1.35,
  readingZonePercent: 38,
  readingZoneHeightLines: 1,
  showActiveHighlight: false,
  continuousAssistScroll: false,
  assistScrollSpeed: 50,
  assistCorrectionFeel: 45,
  theme: 'dark',
  autoHideControlsOnStart: false,
  readingLookaheadTokens: 6
};

export const LEGACY_LOW_READING_ZONE_PERCENT = 55;

export function resolveInitialDisplaySettings(
  storedDisplaySettings?: Partial<DisplaySettings>,
  options: { migrateLegacyNarrationDefaults?: boolean } = {}
): DisplaySettings {
  const settings = {
    ...DEFAULT_DISPLAY_SETTINGS,
    ...storedDisplaySettings
  };

  if (!Number.isFinite(settings.readingZonePercent)) {
    settings.readingZonePercent = DEFAULT_DISPLAY_SETTINGS.readingZonePercent;
  }

  if (!Number.isFinite(settings.readingZoneHeightLines)) {
    settings.readingZoneHeightLines = DEFAULT_DISPLAY_SETTINGS.readingZoneHeightLines;
  } else {
    settings.readingZoneHeightLines = Math.max(
      1,
      Math.min(2.5, Math.round(settings.readingZoneHeightLines * 10) / 10)
    );
  }

  if (!Number.isFinite(settings.assistScrollSpeed)) {
    settings.assistScrollSpeed = DEFAULT_DISPLAY_SETTINGS.assistScrollSpeed;
  } else {
    settings.assistScrollSpeed = Math.max(1, Math.min(100, Math.round(settings.assistScrollSpeed)));
  }

  if (!Number.isFinite(settings.assistCorrectionFeel)) {
    settings.assistCorrectionFeel = DEFAULT_DISPLAY_SETTINGS.assistCorrectionFeel;
  } else {
    settings.assistCorrectionFeel = Math.max(1, Math.min(100, Math.round(settings.assistCorrectionFeel)));
  }

  if (typeof settings.autoHideControlsOnStart !== 'boolean') {
    settings.autoHideControlsOnStart = DEFAULT_DISPLAY_SETTINGS.autoHideControlsOnStart;
  }

  if (typeof settings.readingLookaheadTokens !== 'number' || !Number.isFinite(settings.readingLookaheadTokens)) {
    settings.readingLookaheadTokens = DEFAULT_DISPLAY_SETTINGS.readingLookaheadTokens;
  } else {
    settings.readingLookaheadTokens = Math.max(0, Math.min(20, Math.round(settings.readingLookaheadTokens)));
  }

  if (options.migrateLegacyNarrationDefaults && storedDisplaySettings) {
    if (
      typeof storedDisplaySettings.readingZonePercent === 'number' &&
      storedDisplaySettings.readingZonePercent > LEGACY_LOW_READING_ZONE_PERCENT
    ) {
      settings.readingZonePercent = DEFAULT_DISPLAY_SETTINGS.readingZonePercent;
    }

    if (storedDisplaySettings.showActiveHighlight === true) {
      settings.showActiveHighlight = DEFAULT_DISPLAY_SETTINGS.showActiveHighlight;
    }
  }

  return settings;
}

export const DEFAULT_LOCAL_WHISPER_SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'base.en',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 2
};

export const SAMPLE_MANUSCRIPT = `The studio light blinked once, and Mara took that as permission to begin.

She drew a quiet breath, settled her eyes on the page, and read the first sentence as if it had been waiting for her all morning. The room did not answer. That was the bargain.

Halfway through the paragraph, she missed a word, stopped, and smiled at nobody. She backed up to the previous sentence and began again. The room did not answer. That was the bargain.

By noon, the manuscript had become less like a stack of pages and more like a trail through familiar woods. When she lost the path, she did not panic. She found the last true sentence, placed her voice there, and moved forward.

She continued through the next chapter without pause. The light held steady above the desk. Every sentence landed where it belonged, one after another.

The final page turned under her hand. She spoke the last line clearly, then let the silence settle. The room did not answer. That was the bargain, kept.`;

export const DEFAULT_MOCK_SCRIPT = `The studio light blinked once
and Mara took that as permission to begin
She drew a quiet breath settled her eyes on the page
and read the first sentence
[pause]
this is a pickup note ignore me
The room did not answer that was the bargain
Halfway through the paragraph she missed a word
damn let me take that again
She backed up to the previous sentence and began again
The room did not answer that was the bargain
By noon the manuscript had become less like a stack of pages
She continued through the next chapter without pause
The light held steady above the desk
Every sentence landed where it belonged
The final page turned under her hand
She spoke the last line clearly then let the silence settle`;
