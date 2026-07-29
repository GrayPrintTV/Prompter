import { alignTranscript } from './alignment.js';
import { COMMON_WORDS, transcriptToTokens } from './normalize.js';
import type { AlignmentResult, ManuscriptModel } from './types.js';
import { HIGH_CONFIDENCE } from './scrollModel.js';

const MAX_COMMITTED_TOKENS = 28;
const MAX_PROVISIONAL_TOKENS = 18;
const ANCHOR_CONFIDENCE = 0.3;
const OFFSCRIPT_CLEAR_COUNT = 3;

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
  selectedCandidateStartTokenIndex: number;
  selectedCandidateEndTokenIndex: number;
  newDeltaMatchedWordCount: number;
  newDeltaDistinctiveMatchedWordCount: number;
  commitRejectedReason: string | null;
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

function isDistinctiveToken(token: string) {
  return token.length >= 4 && !COMMON_WORDS.has(token);
}

function hasDistinctiveToken(tokens: string[]) {
  return tokens.some(isDistinctiveToken);
}

function matchedDeltaContribution(candidateTokens: string[], deltaTokens: string[], result: AlignmentResult) {
  const deltaStart = Math.max(0, candidateTokens.length - deltaTokens.length);
  const indexes = result.diagnostics?.selectedTranscriptTokenIndexes ?? [];
  return indexes
    .filter((index) => index >= deltaStart && index < candidateTokens.length)
    .map((index) => candidateTokens[index])
    .filter(Boolean);
}

export function evaluateProvisionalAlignmentBuffer(
  model: ManuscriptModel,
  state: AlignmentBufferState,
  deltaTokens: string[],
  currentTokenIndex: number,
  options: {
    widenWindow?: boolean;
    backwardWindow?: number;
    forwardWindow?: number;
  } = {}
): AlignmentBufferDecision {
  const candidateTokens = clampRecent(
    [...state.committedTokens, ...state.provisionalTokens, ...deltaTokens],
    MAX_COMMITTED_TOKENS
  );
  const result = alignTranscript(model, candidateTokens, currentTokenIndex, {
    widenWindow: options.widenWindow,
    backwardWindow: options.backwardWindow,
    forwardWindow: options.forwardWindow,
    maxTranscriptTokens: MAX_COMMITTED_TOKENS
  });
  const deltaResult = alignTranscript(model, deltaTokens, currentTokenIndex, {
    widenWindow: options.widenWindow,
    backwardWindow: options.backwardWindow,
    forwardWindow: options.forwardWindow,
    maxTranscriptTokens: MAX_COMMITTED_TOKENS
  });

  const retainedTokens = matchedDeltaContribution(candidateTokens, deltaTokens, result);
  const deltaHasAnchor = hasDistinctiveToken(retainedTokens);
  const newDeltaMatchedWordCount = retainedTokens.length;
  const newDeltaDistinctiveMatchedWordCount = retainedTokens.filter(isDistinctiveToken).length;
  const selectedCandidateStartTokenIndex = result.diagnostics?.selectedCandidateStartTokenIndex ?? currentTokenIndex;
  const selectedCandidateEndTokenIndex = result.diagnostics?.selectedCandidateEndTokenIndex ?? result.tokenIndex;
  const metadata = { selectedCandidateStartTokenIndex, selectedCandidateEndTokenIndex, newDeltaMatchedWordCount, newDeltaDistinctiveMatchedWordCount };
  const staleCandidateRejected = result.confidence >= HIGH_CONFIDENCE && !deltaHasAnchor;

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
      retentionReason: 'committed provisional context after high-confidence manuscript match',
      ...metadata, commitRejectedReason: null
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
      retentionReason: `retained matched manuscript anchors: ${retainedTokens.join(' ')}`,
      ...metadata, commitRejectedReason: null
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
      : 'discarded off-script delta from alignment context',
    ...metadata,
    commitRejectedReason: staleCandidateRejected ? 'selected candidate has no distinctive current-delta match' : null
  };
}

export function alignmentBufferTokens(state: AlignmentBufferState) {
  return clampRecent([...state.committedTokens, ...state.provisionalTokens], MAX_COMMITTED_TOKENS);
}
