import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_SETTINGS, DEFAULT_LOCAL_WHISPER_SETTINGS } from '../state/appStore';
import { loadSession, saveSession } from '../state/projectStore';

describe('project session persistence', () => {
  beforeEach(() => localStorage.clear());

  it('restores the last manuscript and current position', () => {
    saveSession({
      projectTitle: 'Audition Script',
      manuscriptText: 'Opening paragraph.\n\nLater audition paragraph.',
      currentTokenIndex: 17,
      currentSentenceIndex: 2,
      currentParagraphIndex: 1,
      displaySettings: DEFAULT_DISPLAY_SETTINGS,
      followState: 'manual',
      selectedAsrProviderId: 'local-whisper',
      localWhisperSettings: DEFAULT_LOCAL_WHISPER_SETTINGS,
      mockScript: '',
      debugVisible: false,
      developerMode: false
    });

    const restored = loadSession();
    expect(restored?.projectTitle).toBe('Audition Script');
    expect(restored?.manuscriptText).toContain('Later audition paragraph.');
    expect(restored?.currentTokenIndex).toBe(17);
    expect(restored?.currentSentenceIndex).toBe(2);
    expect(restored?.currentParagraphIndex).toBe(1);
    expect(restored?.displaySettings?.addExtraSpacingOnImport).toBe(true);
    expect(restored?.developerMode).toBe(false);
  });
});
