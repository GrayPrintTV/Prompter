import type { AsrProviderId, DisplaySettings, FollowState, LocalWhisperSettings } from '../domain/types';

export type StoredSession = {
  projectTitle: string;
  manuscriptText: string;
  currentTokenIndex: number;
  currentSentenceIndex: number;
  currentParagraphIndex: number;
  displaySettings: DisplaySettings;
  followState: FollowState;
  selectedAsrProviderId: AsrProviderId;
  localWhisperSettings: LocalWhisperSettings;
  mockScript: string;
  debugVisible: boolean;
  developerMode: boolean;
};

const STORAGE_KEY = 'narration-prompter.phase0.session';

export function loadSession(): Partial<StoredSession> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<StoredSession>) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Local storage can be unavailable in hardened contexts; the app remains usable.
  }
}
