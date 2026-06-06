import { alignTranscript } from './alignment';
import {
  clampTokenIndex,
  findParagraphIndexForSentence,
  findSentenceIndexForToken
} from './manuscript';
import { transcriptToTokens } from './normalize';
import { HIGH_CONFIDENCE, stateFromAlignment } from './scrollModel';
import type { AlignmentResult, FollowState, ManuscriptModel } from './types';

export const TORTURE_TRANSCRIPT_BUFFER_LIMIT = 28;

export type TorturePosition = {
  tokenIndex: number;
  sentenceIndex: number;
  paragraphIndex: number;
};

export type TortureDiagnosticCode =
  | 'moved-high-confidence'
  | 'held-empty-transcript'
  | 'held-low-confidence'
  | 'held-manual-or-paused';

export type TortureHarnessState = {
  currentTokenIndex: number;
  followState: FollowState;
  transcriptBuffer: string[];
  lowConfidenceCount: number;
  resyncArmed: boolean;
};

export type TortureStepReport = {
  rawTranscriptChunk: string;
  normalizedTranscriptTokens: string[];
  bestManuscriptMatch: string;
  confidenceScore: number;
  previousManuscriptPosition: TorturePosition;
  newManuscriptPosition: TorturePosition;
  alignmentPosition: TorturePosition;
  appState: FollowState;
  diagnosticCode: TortureDiagnosticCode;
  reason: string;
  moved: boolean;
  searchWindow: AlignmentResult['searchWindow'];
};

export type TortureStepOutcome = {
  nextState: TortureHarnessState;
  report: TortureStepReport;
};

export type TortureRunOutcome = {
  finalState: TortureHarnessState;
  reports: TortureStepReport[];
};

function positionForToken(model: ManuscriptModel, tokenIndex: number): TorturePosition {
  const clamped = clampTokenIndex(model, tokenIndex);
  const sentenceIndex = findSentenceIndexForToken(model, clamped);
  return {
    tokenIndex: clamped,
    sentenceIndex,
    paragraphIndex: findParagraphIndexForSentence(model, sentenceIndex)
  };
}

function emptyAlignment(model: ManuscriptModel, tokenIndex: number, reason: string): AlignmentResult {
  const position = positionForToken(model, tokenIndex);
  return {
    tokenIndex: position.tokenIndex,
    sentenceIndex: position.sentenceIndex,
    paragraphIndex: position.paragraphIndex,
    confidence: 0,
    matchedText: '',
    reason,
    searchWindow: { fromToken: 0, toToken: model.tokens.length }
  };
}

function isPauseChunk(rawTranscriptChunk: string) {
  const trimmed = rawTranscriptChunk.trim();
  return trimmed === '' || /^\[pause\]$/i.test(trimmed);
}

function buildReport(
  model: ManuscriptModel,
  rawTranscriptChunk: string,
  normalizedTranscriptTokens: string[],
  alignment: AlignmentResult,
  previousTokenIndex: number,
  newTokenIndex: number,
  appState: FollowState,
  diagnosticCode: TortureDiagnosticCode,
  reason: string
): TortureStepReport {
  return {
    rawTranscriptChunk,
    normalizedTranscriptTokens,
    bestManuscriptMatch: alignment.matchedText,
    confidenceScore: alignment.confidence,
    previousManuscriptPosition: positionForToken(model, previousTokenIndex),
    newManuscriptPosition: positionForToken(model, newTokenIndex),
    alignmentPosition: positionForToken(model, alignment.tokenIndex),
    appState,
    diagnosticCode,
    reason,
    moved: newTokenIndex !== previousTokenIndex,
    searchWindow: alignment.searchWindow
  };
}

export function createTortureHarnessState(
  model: ManuscriptModel,
  startTokenIndex = 0,
  followState: FollowState = 'following'
): TortureHarnessState {
  return {
    currentTokenIndex: clampTokenIndex(model, startTokenIndex),
    followState,
    transcriptBuffer: [],
    lowConfidenceCount: 0,
    resyncArmed: false
  };
}

export function findTortureStartToken(model: ManuscriptModel, phrase?: string, occurrence = 0) {
  const phraseTokens = transcriptToTokens(phrase ?? '');
  if (phraseTokens.length === 0) return 0;

  const lastStart = model.tokens.length - phraseTokens.length;
  let seen = 0;

  for (let startIndex = 0; startIndex <= lastStart; startIndex += 1) {
    const matched = phraseTokens.every((token, index) => model.tokens[startIndex + index]?.text === token);
    if (!matched) continue;
    if (seen === occurrence) return startIndex;
    seen += 1;
  }

  return 0;
}

export function runTortureChunk(
  model: ManuscriptModel,
  state: TortureHarnessState,
  rawTranscriptChunk: string,
  options: { widenWindow?: boolean } = {}
): TortureStepOutcome {
  const previousTokenIndex = clampTokenIndex(model, state.currentTokenIndex);
  const transcriptText = isPauseChunk(rawTranscriptChunk) ? '' : rawTranscriptChunk;
  const normalizedTranscriptTokens = transcriptToTokens(transcriptText);

  if (normalizedTranscriptTokens.length === 0) {
    const appState: FollowState = state.followState === 'manual' ? 'manual' : 'holding';
    const alignment = emptyAlignment(model, previousTokenIndex, 'No transcript words in chunk; holding position.');
    const nextState: TortureHarnessState = {
      ...state,
      currentTokenIndex: previousTokenIndex,
      followState: appState,
      resyncArmed: false
    };

    return {
      nextState,
      report: buildReport(
        model,
        rawTranscriptChunk,
        normalizedTranscriptTokens,
        alignment,
        previousTokenIndex,
        previousTokenIndex,
        appState,
        'held-empty-transcript',
        alignment.reason
      )
    };
  }

  const transcriptBuffer = [...state.transcriptBuffer, ...normalizedTranscriptTokens].slice(
    -TORTURE_TRANSCRIPT_BUFFER_LIMIT
  );
  const wasResyncing = state.resyncArmed || state.followState === 'resyncing' || Boolean(options.widenWindow);
  const alignment = alignTranscript(model, transcriptBuffer, previousTokenIndex, {
    widenWindow: wasResyncing || state.followState === 'lost'
  });

  let appState = state.followState;
  let newTokenIndex = previousTokenIndex;
  let lowConfidenceCount = state.lowConfidenceCount;
  let reason = alignment.reason;
  let diagnosticCode: TortureDiagnosticCode = 'held-low-confidence';

  if (state.followState === 'manual' || state.followState === 'paused') {
    reason = `${state.followState} mode; aligned for diagnostics but held visual position. ${alignment.reason}`;
    diagnosticCode = 'held-manual-or-paused';
  } else if (alignment.confidence >= HIGH_CONFIDENCE) {
    lowConfidenceCount = 0;
    newTokenIndex = clampTokenIndex(model, alignment.tokenIndex);
    appState = stateFromAlignment(alignment, previousTokenIndex, wasResyncing, 0);
    reason = `Moved on high confidence. ${alignment.reason}`;
    diagnosticCode = 'moved-high-confidence';
  } else {
    lowConfidenceCount += 1;
    appState = stateFromAlignment(alignment, previousTokenIndex, wasResyncing, lowConfidenceCount);
    reason = `Held because confidence ${alignment.confidence.toFixed(3)} is below ${HIGH_CONFIDENCE}. ${alignment.reason}`;
    diagnosticCode = 'held-low-confidence';
  }

  const nextState: TortureHarnessState = {
    currentTokenIndex: newTokenIndex,
    followState: appState,
    transcriptBuffer,
    lowConfidenceCount,
    resyncArmed: false
  };

  return {
    nextState,
    report: buildReport(
      model,
      rawTranscriptChunk,
      normalizedTranscriptTokens,
      alignment,
      previousTokenIndex,
      newTokenIndex,
      appState,
      diagnosticCode,
      reason
    )
  };
}

export function runTortureSequence(
  model: ManuscriptModel,
  rawTranscriptChunks: string[],
  initialState = createTortureHarnessState(model)
): TortureRunOutcome {
  let state = initialState;
  const reports: TortureStepReport[] = [];

  for (const chunk of rawTranscriptChunks) {
    const outcome = runTortureChunk(model, state, chunk);
    state = outcome.nextState;
    reports.push(outcome.report);
  }

  return {
    finalState: state,
    reports
  };
}
