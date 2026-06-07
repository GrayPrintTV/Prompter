import { alignTranscript } from './alignment';
import { COMMON_WORDS, transcriptToTokens } from './normalize';
import type { AlignmentResult, ManuscriptModel } from './types';
import { HIGH_CONFIDENCE } from './scrollModel';

const MAX_COMMITTED_TOKENS = 28;
const MAX_PROVISIONAL_TOKENS = 18;
const ANCHOR_CONFIDENCE = 0.3;
const OFFSCRIPT_CLEAR_COUNT = 3;
const ISOLATED_SINGLE_ANCHOR_WINDOW = 24;

export type AlignmentBufferState = {
  committedTokens: string[];
  provisionalTokens: string[];
  consecutiveOffScriptDeltas: number;
};

export type AlignmentBufferDecision = {
  state: AlignmentBufferState;
  evaluationTokens: string[];
  result: AlignmentResult;
  deltaResult: AlignmentResult;
  retainedDelta: boolean;
  retainedTokens: string[];
  clearedProvisional: boolean;
  moveRecommended: boolean;
  retentionReason: string;
};

export function createAlignmentBufferState(): AlignmentBufferState {
  return {
    committedTokens: [],
    provisionalTokens: [],
    consecutiveOffScriptDeltas: 0
  };
}

function clampRecent(tokens: string[], maxTokens: number) {
  return tokens.slice(-maxTokens);
}

function hasDistinctiveMatch(result: AlignmentResult) {
  const matchedTokens = transcriptToTokens(result.matchedText);
  return matchedTokens.some((token) => token.length >= 4 && !COMMON_WORDS.has(token));
}

function isDistinctiveToken(token: string) {
  return token.length >= 4 && !COMMON_WORDS.has(token);
}

function hasDistinctiveToken(tokens: string[]) {
  return tokens.some(isDistinctiveToken);
}

function isNearbyDeltaAnchor(deltaResult: AlignmentResult, currentTokenIndex: number) {
  if (deltaResult.confidence < ANCHOR_CONFIDENCE || !hasDistinctiveMatch(deltaResult)) return false;

  const distinctiveTokens = transcriptToTokens(deltaResult.matchedText).filter(isDistinctiveToken);
  if (
    distinctiveTokens.length === 1 &&
    Math.abs(deltaResult.tokenIndex - currentTokenIndex) > ISOLATED_SINGLE_ANCHOR_WINDOW
  ) {
    return false;
  }

  return true;
}

function matchedDeltaContribution(deltaTokens: string[], result: AlignmentResult, deltaResult: AlignmentResult, currentTokenIndex: number) {
  if (isNearbyDeltaAnchor(deltaResult, currentTokenIndex)) {
    return transcriptToTokens(deltaResult.matchedText);
  }

  const matchedTokens = new Set(transcriptToTokens(result.matchedText));
  const exactContribution = deltaTokens.filter((token) => matchedTokens.has(token));
  return hasDistinctiveToken(exactContribution) ? exactContribution : [];
}

export function evaluateProvisionalAlignmentBuffer(
  model: ManuscriptModel,
  state: AlignmentBufferState,
  deltaTokens: string[],
  currentTokenIndex: number,
  options: { widenWindow?: boolean } = {}
): AlignmentBufferDecision {
  const candidateTokens = clampRecent(
    [...state.committedTokens, ...state.provisionalTokens, ...deltaTokens],
    MAX_COMMITTED_TOKENS
  );
  const result = alignTranscript(model, candidateTokens, currentTokenIndex, {
    widenWindow: options.widenWindow,
    maxTranscriptTokens: MAX_COMMITTED_TOKENS
  });
  const deltaResult = alignTranscript(model, deltaTokens, currentTokenIndex, {
    widenWindow: options.widenWindow,
    maxTranscriptTokens: MAX_COMMITTED_TOKENS
  });

  const retainedTokens = matchedDeltaContribution(deltaTokens, result, deltaResult, currentTokenIndex);
  const deltaHasAnchor = hasDistinctiveToken(retainedTokens);

  if (result.confidence >= HIGH_CONFIDENCE && deltaHasAnchor) {
    const committedTokens = clampRecent(transcriptToTokens(result.matchedText), MAX_COMMITTED_TOKENS);

    return {
      state: {
        committedTokens,
        provisionalTokens: [],
        consecutiveOffScriptDeltas: 0
      },
      evaluationTokens: candidateTokens,
      result,
      deltaResult,
      retainedDelta: true,
      retainedTokens,
      clearedProvisional: state.provisionalTokens.length > 0,
      moveRecommended: true,
      retentionReason: 'committed provisional context after high-confidence manuscript match'
    };
  }

  if (
    deltaHasAnchor &&
    (result.confidence >= ANCHOR_CONFIDENCE || deltaResult.confidence >= ANCHOR_CONFIDENCE)
  ) {
    const provisionalTokens = clampRecent(
      [...state.provisionalTokens, ...retainedTokens],
      MAX_PROVISIONAL_TOKENS
    );
    return {
      state: {
        ...state,
        provisionalTokens,
        consecutiveOffScriptDeltas: 0
      },
      evaluationTokens: candidateTokens,
      result,
      deltaResult,
      retainedDelta: true,
      retainedTokens,
      clearedProvisional: false,
      moveRecommended: false,
      retentionReason: `retained matched manuscript anchors: ${retainedTokens.join(' ')}`
    };
  }

  const consecutiveOffScriptDeltas = state.consecutiveOffScriptDeltas + 1;
  const clearedProvisional = consecutiveOffScriptDeltas >= OFFSCRIPT_CLEAR_COUNT && state.provisionalTokens.length > 0;
  return {
    state: {
      ...state,
      provisionalTokens: clearedProvisional ? [] : state.provisionalTokens,
      consecutiveOffScriptDeltas
    },
    evaluationTokens: candidateTokens,
    result,
    deltaResult,
    retainedDelta: false,
    retainedTokens: [],
    clearedProvisional,
    moveRecommended: false,
    retentionReason: clearedProvisional
      ? 'discarded off-script delta and cleared stale provisional anchors after repeated misses'
      : 'discarded off-script delta from alignment context'
  };
}

export function alignmentBufferTokens(state: AlignmentBufferState) {
  return clampRecent([...state.committedTokens, ...state.provisionalTokens], MAX_COMMITTED_TOKENS);
}
