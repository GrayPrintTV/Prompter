import type { AlignmentResult, FollowState } from './types.js';

export const HIGH_CONFIDENCE = 0.76;
export const MEDIUM_CONFIDENCE = 0.54;

export function stateFromAlignment(
  result: AlignmentResult,
  previousTokenIndex: number,
  wasResyncing: boolean,
  lowConfidenceCount: number
): FollowState {
  if (result.confidence >= HIGH_CONFIDENCE) {
    if (result.tokenIndex < previousTokenIndex - 8) return 'retake';
    return wasResyncing ? 'resyncing' : 'following';
  }

  if (result.confidence >= MEDIUM_CONFIDENCE) {
    return 'uncertain';
  }

  return lowConfidenceCount >= 3 ? 'lost' : 'holding';
}

export function shouldScrollForState(state: FollowState, confidence: number) {
  if (state === 'manual') return true;
  return confidence >= HIGH_CONFIDENCE && (state === 'following' || state === 'retake' || state === 'resyncing');
}
