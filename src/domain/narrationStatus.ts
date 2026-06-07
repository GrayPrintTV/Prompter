import { HIGH_CONFIDENCE } from './scrollModel';
import type { FollowState } from './types';

export type NarrationStatusLabel =
  | 'Idle'
  | 'Starting'
  | 'Listening'
  | 'Following'
  | 'Holding'
  | 'Lagging'
  | 'Error';

export type NarrationStatusInput = {
  isRunning: boolean;
  isStarting: boolean;
  followState: FollowState;
  confidence: number;
  expectsMic: boolean;
  micActive: boolean;
  inputLevel: number;
  isLagging: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
};

export type NarrationStatus = {
  label: NarrationStatusLabel;
  tone: 'idle' | 'good' | 'warning' | 'error';
  warning: string | null;
};

export function deriveNarrationStatus({
  isRunning,
  isStarting,
  followState,
  confidence,
  expectsMic,
  micActive,
  inputLevel,
  isLagging,
  errorMessage,
  warningMessage
}: NarrationStatusInput): NarrationStatus {
  if (errorMessage) {
    return {
      label: 'Error',
      tone: 'error',
      warning: errorMessage
    };
  }

  if (isStarting) {
    return {
      label: 'Starting',
      tone: 'warning',
      warning: warningMessage ?? null
    };
  }

  if (!isRunning) {
    return {
      label: 'Idle',
      tone: 'idle',
      warning: warningMessage ?? null
    };
  }

  if (expectsMic && !micActive) {
    return {
      label: 'Error',
      tone: 'error',
      warning: 'Microphone is inactive while narration is running.'
    };
  }

  const micWarning = expectsMic && inputLevel <= 0.005 ? 'Mic level is quiet.' : null;
  const warning = warningMessage ?? micWarning;

  if (isLagging) {
    return {
      label: 'Lagging',
      tone: 'warning',
      warning
    };
  }

  if (followState === 'holding' || followState === 'uncertain' || followState === 'lost') {
    return {
      label: 'Holding',
      tone: 'warning',
      warning
    };
  }

  if (
    (followState === 'following' || followState === 'retake' || followState === 'resyncing') &&
    confidence >= HIGH_CONFIDENCE
  ) {
    return {
      label: 'Following',
      tone: warning ? 'warning' : 'good',
      warning
    };
  }

  return {
    label: 'Listening',
    tone: warning ? 'warning' : 'good',
    warning
  };
}
