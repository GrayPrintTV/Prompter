import { HIGH_CONFIDENCE } from './scrollModel';
import type { FollowState, LocalWhisperChunkDiagnostics } from './types';

export const TRANSCRIPTION_SOFT_TIMEOUT_MS = 15_000;
const SPEECH_ACTIVITY_GRACE_MS = 8_000;
export type TranscriptPipelineState = 'normal' | 'stalled' | 'recovering';

export type NarrationStatusLabel =
  | 'Idle'
  | 'Starting'
  | 'Listening'
  | 'Following'
  | 'Holding'
  | 'Lagging'
  | 'Stalled'
  | 'Recovering'
  | 'Error';

export type NarrationStatusInput = {
  isRunning: boolean;
  isStarting: boolean;
  followState: FollowState;
  confidence: number;
  expectsMic: boolean;
  micActive: boolean;
  micStartupGraceActive?: boolean;
  inputLevel: number;
  isLagging: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
  pipelineState?: TranscriptPipelineState;
};

export type NarrationStatus = {
  label: NarrationStatusLabel;
  tone: 'idle' | 'good' | 'warning' | 'error';
  warning: string | null;
};

export type StartDiagnostic = {
  timestampMs: number;
  source: string;
  level: 'warning' | 'error';
  message: string;
  blocking: boolean;
  recovered: boolean;
};

export function isBenignStartDiagnosticMessage(message: string) {
  return /ScriptProcessorNode|createScriptProcessor.*deprecated/i.test(message);
}

export function deriveTranscriptPipelineState(
  activity: Pick<LocalWhisperChunkDiagnostics,
    | 'activeRequestStartedAtMs'
    | 'activeRequestCapturedAtMs'
    | 'lastNonSilentCapturedAtMs'
    | 'unusableSpeechStartedAtMs'
    | 'lastUsableTranscriptCapturedAtMs'
    | 'lastRequestCompletedCaptureAtMs'
    | 'lastRequestWasDelayed'>,
  followState: FollowState,
  nowMs: number,
  softTimeoutMs = TRANSCRIPTION_SOFT_TIMEOUT_MS
): TranscriptPipelineState {
  const hasActiveSpeechRequest =
    activity.activeRequestStartedAtMs > 0 &&
    activity.activeRequestCapturedAtMs > 0 &&
    activity.lastNonSilentCapturedAtMs >= activity.activeRequestCapturedAtMs;
  if (hasActiveSpeechRequest && nowMs - activity.activeRequestStartedAtMs >= softTimeoutMs) {
    return 'stalled';
  }

  const hasOngoingUnusableSpeech =
    activity.unusableSpeechStartedAtMs > 0 &&
    nowMs - activity.unusableSpeechStartedAtMs >= softTimeoutMs &&
    nowMs - activity.lastNonSilentCapturedAtMs <= SPEECH_ACTIVITY_GRACE_MS;
  if (hasOngoingUnusableSpeech) return 'stalled';

  const delayedUsableResultNeedsReacquire =
    activity.activeRequestStartedAtMs === 0 &&
    activity.lastRequestWasDelayed &&
    activity.lastRequestCompletedCaptureAtMs > 0 &&
    activity.lastUsableTranscriptCapturedAtMs >= activity.lastRequestCompletedCaptureAtMs &&
    followState !== 'following' &&
    followState !== 'retake';
  return delayedUsableResultNeedsReacquire ? 'recovering' : 'normal';
}

export function deriveNarrationStatus({
  isRunning,
  isStarting,
  followState,
  confidence,
  expectsMic,
  micActive,
  micStartupGraceActive = false,
  inputLevel,
  isLagging,
  errorMessage,
  warningMessage,
  pipelineState = 'normal'
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
      tone: 'idle',
      warning: null
    };
  }

  if (!isRunning) {
    return {
      label: 'Idle',
      tone: 'idle',
      warning: warningMessage ?? null
    };
  }

  if (expectsMic && !micActive && !micStartupGraceActive) {
    return {
      label: 'Error',
      tone: 'error',
      warning: 'Microphone is inactive while narration is running.'
    };
  }

  const micWarning =
    expectsMic && !micStartupGraceActive && inputLevel <= 0.005 ? 'Mic level is quiet.' : null;
  const warning = warningMessage ?? micWarning;

  if (pipelineState === 'stalled') {
    return {
      label: 'Stalled',
      tone: 'warning',
      warning: warning ?? 'Speech was captured, but transcription is taking longer than expected.'
    };
  }

  if (pipelineState === 'recovering') {
    return {
      label: 'Recovering',
      tone: 'warning',
      warning: warning ?? 'Transcription resumed; waiting to reacquire the manuscript nearby.'
    };
  }

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
