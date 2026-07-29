import type { DisplaySettings } from '../domain/types.js';

export type RuntimeSettings = {
  settingsRevision: number;
  source: 'windows';
  updatedAtMs: number;
  display: {
    backgroundColor: string;
    textColor: string;
    highlightColor: string;
    highlightOpacity: number;
    fontSizeSp: number;
    lineSpacing: number;
    /** Fraction of the tablet viewport reserved for manuscript text (not a CSS width). */
    contentWidthFraction?: number;
    sideMarginsDp: number;
    paragraphSpacingEm: number;
    readingBandFraction: number;
    readingBandHeightLines: number;
  };
  follow: {
    enabled: boolean;
    smoothness: number;
    maximumSpeedDpPerSec: number;
    catchUpAggressiveness: number;
    deadZoneDp: number;
    largeCorrectionPolicy: 'animate' | 'snap';
  };
  serverAlignment: { readingLookaheadTokens: number };
};

export function runtimeSettingsFromDisplay(settings: DisplaySettings, settingsRevision: number, updatedAtMs = Date.now()): RuntimeSettings {
  // These are intentionally calibrated presentation values rather than a direct CSS-pixel copy.
  // 22–78 desktop px maps to roughly 24–74 Android sp; this keeps the default desktop
  // reading scale close to the tablet's previous 36sp default while preserving the full
  // useful range of the Windows control.
  const fontSizeSp = Math.round((settings.fontSizePx * 0.9 + 4) * 10) / 10;
  // `textWidthCh` is a desktop glyph measure. Convert it into a viewport fraction so the
  // tablet can make an appropriate margin on a differently sized portrait display.
  const contentWidthFraction = Math.round((0.52 + ((settings.textWidthCh - 42) / 50) * 0.42) * 1000) / 1000;
  return {
    settingsRevision, source: 'windows', updatedAtMs,
    display: {
      backgroundColor: settings.backgroundColor,
      textColor: settings.textColor,
      highlightColor: settings.highlightColor,
      highlightOpacity: settings.highlightOpacity,
      fontSizeSp: Math.max(18, Math.min(80, fontSizeSp)),
      lineSpacing: settings.lineHeight,
      contentWidthFraction: Math.max(0.52, Math.min(0.94, contentWidthFraction)),
      sideMarginsDp: Math.max(12, Math.round((96 - settings.textWidthCh) * 1.15)),
      paragraphSpacingEm: settings.paragraphSpacingEm,
      readingBandFraction: settings.readingZonePercent / 100,
      readingBandHeightLines: settings.readingZoneHeightLines
    },
    follow: {
      enabled: settings.tabletFollowEnabled,
      smoothness: settings.assistCorrectionFeel / 100,
      maximumSpeedDpPerSec: 240 + settings.assistScrollSpeed * 12,
      catchUpAggressiveness: settings.assistCorrectionFeel / 100,
      deadZoneDp: settings.tabletFollowDeadZoneDp,
      largeCorrectionPolicy: settings.tabletLargeCorrectionPolicy
    },
    serverAlignment: { readingLookaheadTokens: settings.readingLookaheadTokens ?? 0 }
  };
}
