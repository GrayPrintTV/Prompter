import { alignTranscript } from '../domain/alignment';
import {
  alignmentBufferTokens,
  createAlignmentBufferState,
  evaluateProvisionalAlignmentBuffer,
  type AlignmentBufferState
} from '../domain/alignmentBuffer';
import {
  findParagraphIndexForSentence,
  findSentenceIndexForToken
} from '../domain/manuscript';
import {
  MANUAL_REACQUIRE_BACKWARD_WINDOW,
  MANUAL_REACQUIRE_FORWARD_WINDOW,
  isNearManualVisibleAnchor,
  shouldHoldAutomaticBackwardCandidate,
  visibleReacquireAllowsBackward,
  type VisibleReacquireSource
} from '../domain/manualFollow';
import {
  buildMovementDecisionMetrics,
  estimateTokensPerLine,
  proposedTargetFromLookahead,
  type MovementDecisionInfo,
  type MovementDecisionOutcome
} from '../domain/movementDiagnostics';
import { transcriptToTokens } from '../domain/normalize';
import { HIGH_CONFIDENCE, stateFromAlignment } from '../domain/scrollModel';
import type {
  AlignmentBufferDebug,
  AlignmentResult,
  DisplaySettings,
  FollowState,
  ManuscriptModel,
  TranscriptDelta
} from '../domain/types';

export const EMPTY_SESSION_ALIGNMENT_DEBUG: AlignmentBufferDebug = {
  source: '', rawTranscript: '', normalizedTokens: [], retainedTokens: [], rollingBufferTokens: [],
  provisionalBufferTokens: [], evaluationBufferTokens: [], matchedText: '', confidence: 0,
  moveDecision: 'Waiting for transcript.', moveToTokenCalled: false,
  retentionDecision: 'none', retentionReason: 'No transcript processed yet.'
};

export type VisibleReacquireAnchor = {
  source: VisibleReacquireSource;
  visibleTokenIndex: number;
  detectedAtMs: number;
  direction: 'backward' | 'forward' | 'stationary';
  hadFreshConfirmedAnchor: boolean;
};

export type SessionCoordinatorState = {
  currentTokenIndex: number;
  currentCharacter: number;
  currentSentenceIndex: number;
  currentParagraphIndex: number;
  followState: FollowState;
  alignment: AlignmentResult;
  confidence: number;
  transcriptBuffer: string[];
  latestTranscript: string;
  alignmentBufferDebug: AlignmentBufferDebug;
  manualReacquireAnchor: VisibleReacquireAnchor | null;
  movementDecision: MovementDecisionInfo | null;
  movementDecisionHistory: MovementDecisionInfo[];
  sessionRevision: number;
  manuscriptRevision: number;
};

export type SessionTranscriptResult = {
  state: SessionCoordinatorState;
  traces: string[];
  inputLevel: number;
};

export type RecordMovementParams = {
  source: string;
  previousTokenIndex?: number;
  result?: AlignmentResult;
  confirmedTokenIndex?: number;
  proposedTargetTokenIndex?: number;
  confidence?: number;
  followState: FollowState;
  finalMovement: MovementDecisionOutcome;
  engineReason?: string;
  alignmentContext?: string;
  markFreshAnchor?: boolean;
  visibleAnchorTokenIndex?: number;
};

export type SerializableSessionSnapshot = {
  sessionRevision: number;
  manuscriptRevision: number;
  manuscript: {
    manuscriptId: string;
    contentHash: string;
    normalizedContent: string;
    paragraphs: Array<{ paragraphIndex: number; characterRange: { start: number; end: number }; sentenceStart: number; sentenceEnd: number }>;
    sentences: Array<{ sentenceIndex: number; paragraphIndex: number; characterRange: { start: number; end: number }; tokenStart: number; tokenEnd: number }>;
    tokens: Array<{ tokenIndex: number; sentenceIndex: number; paragraphIndex: number; characterRange: { start: number; end: number } }>;
  };
  acceptedPosition: {
    tokenIndex: number;
    character: number;
    sentenceIndex: number;
    paragraphIndex: number;
  };
  followState: FollowState;
  currentConfidence: number;
  latestTranscript: string;
  controllerLease: null;
  displayHints: {
    readingZonePercent: number;
    readingLookaheadTokens: number;
    theme: 'dark' | 'light';
  };
  movementDecision: MovementDecisionInfo | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function emptyAlignment(model: ManuscriptModel, tokenIndex: number): AlignmentResult {
  const sentenceIndex = findSentenceIndexForToken(model, tokenIndex);
  return {
    tokenIndex,
    sentenceIndex,
    paragraphIndex: findParagraphIndexForSentence(model, sentenceIndex),
    confidence: 0,
    matchedText: '',
    reason: 'Waiting for transcript.',
    searchWindow: { fromToken: 0, toToken: model.tokens.length }
  };
}

function manuscriptTokenSnippet(model: ManuscriptModel, tokenIndex: number, radius = 5) {
  if (model.tokens.length === 0) return 'No manuscript tokens.';
  const center = clamp(Math.round(tokenIndex), 0, model.tokens.length - 1);
  return model.tokens
    .slice(clamp(center - radius, 0, model.tokens.length), clamp(center + radius + 1, 0, model.tokens.length))
    .map((token) => token.originalText || token.text)
    .join(' ')
    .slice(0, 110);
}

export class SessionCoordinator {
  private model: ManuscriptModel;
  private displaySettings: DisplaySettings;
  private currentTokenIndex: number;
  private followState: FollowState;
  private alignment: AlignmentResult;
  private transcriptBuffer: string[] = [];
  private localAlignmentBuffer: AlignmentBufferState = createAlignmentBufferState();
  private resyncArmed = false;
  private lowConfidenceCount = 0;
  private manualAnchor: VisibleReacquireAnchor | null = null;
  private lastFreshAnchor: { tokenIndex: number; timestampMs: number } | null = null;
  private movementDecision: MovementDecisionInfo | null = null;
  private movementHistory: MovementDecisionInfo[] = [];
  private movementId = 0;
  private latestTranscript = '';
  private alignmentBufferDebug: AlignmentBufferDebug = { ...EMPTY_SESSION_ALIGNMENT_DEBUG };
  private sessionRevision = 0;
  private manuscriptRevision = 0;
  private readonly now?: () => number;

  constructor(input: {
    manuscript: ManuscriptModel;
    currentTokenIndex?: number;
    followState?: FollowState;
    displaySettings: DisplaySettings;
    now?: () => number;
  }) {
    this.model = input.manuscript;
    this.displaySettings = input.displaySettings;
    this.currentTokenIndex = this.clampToken(input.currentTokenIndex ?? 0);
    this.followState = input.followState ?? 'manual';
    this.now = input.now;
    this.alignment = emptyAlignment(this.model, this.currentTokenIndex);
  }

  getState(): SessionCoordinatorState {
    const sentenceIndex = findSentenceIndexForToken(this.model, this.currentTokenIndex);
    const token = this.model.tokens[this.currentTokenIndex];
    return {
      currentTokenIndex: this.currentTokenIndex,
      currentCharacter: token?.charStart ?? 0,
      currentSentenceIndex: sentenceIndex,
      currentParagraphIndex: findParagraphIndexForSentence(this.model, sentenceIndex),
      followState: this.followState,
      alignment: this.alignment,
      confidence: this.alignment.confidence,
      transcriptBuffer: [...this.transcriptBuffer],
      latestTranscript: this.latestTranscript,
      alignmentBufferDebug: {
        ...this.alignmentBufferDebug,
        normalizedTokens: [...this.alignmentBufferDebug.normalizedTokens],
        retainedTokens: [...this.alignmentBufferDebug.retainedTokens],
        rollingBufferTokens: [...this.alignmentBufferDebug.rollingBufferTokens],
        provisionalBufferTokens: [...this.alignmentBufferDebug.provisionalBufferTokens],
        evaluationBufferTokens: [...this.alignmentBufferDebug.evaluationBufferTokens]
      },
      manualReacquireAnchor: this.manualAnchor ? { ...this.manualAnchor } : null,
      movementDecision: this.movementDecision ? { ...this.movementDecision } : null,
      movementDecisionHistory: this.movementHistory.map((decision) => ({ ...decision })),
      sessionRevision: this.sessionRevision,
      manuscriptRevision: this.manuscriptRevision
    };
  }

  toSerializableSnapshot(identity: { manuscriptId: string; contentHash: string } = {
    manuscriptId: 'desktop-current-manuscript',
    contentHash: `unhashed:${this.model.rawText.length}`
  }): SerializableSessionSnapshot {
    const state = this.getState();
    return {
      sessionRevision: state.sessionRevision,
      manuscriptRevision: state.manuscriptRevision,
      manuscript: {
        ...identity,
        normalizedContent: this.model.rawText,
        paragraphs: this.model.paragraphs.map(({ paragraphIndex, charStart, charEnd, sentenceStart, sentenceEnd }) => ({ paragraphIndex, characterRange: { start: charStart, end: charEnd }, sentenceStart, sentenceEnd })),
        sentences: this.model.sentences.map(({ sentenceIndex, paragraphIndex, charStart, charEnd, tokenStart, tokenEnd }) => ({ sentenceIndex, paragraphIndex, characterRange: { start: charStart, end: charEnd }, tokenStart, tokenEnd })),
        tokens: this.model.tokens.map(({ tokenIndex, sentenceIndex, paragraphIndex, charStart, charEnd }) => ({ tokenIndex, sentenceIndex, paragraphIndex, characterRange: { start: charStart, end: charEnd } }))
      },
      acceptedPosition: {
        tokenIndex: state.currentTokenIndex,
        character: state.currentCharacter,
        sentenceIndex: state.currentSentenceIndex,
        paragraphIndex: state.currentParagraphIndex
      },
      followState: state.followState,
      currentConfidence: state.confidence,
      latestTranscript: state.latestTranscript,
      controllerLease: null,
      displayHints: {
        readingZonePercent: this.displaySettings.readingZonePercent,
        readingLookaheadTokens: this.displaySettings.readingLookaheadTokens ?? 0,
        theme: this.displaySettings.theme
      },
      movementDecision: state.movementDecision
    };
  }

  setDisplaySettings(settings: DisplaySettings) {
    this.displaySettings = settings;
  }

  replaceManuscript(manuscript: ManuscriptModel, tokenIndex = this.currentTokenIndex) {
    this.model = manuscript;
    this.currentTokenIndex = this.clampToken(tokenIndex);
    this.manuscriptRevision += 1;
    this.resetTranscriptContext();
    this.alignment = emptyAlignment(this.model, this.currentTokenIndex);
    this.movementDecision = null;
    this.movementHistory = [];
    this.bumpRevision();
    return this.getState();
  }

  setPosition(tokenIndex: number, followState: FollowState = 'manual') {
    this.currentTokenIndex = this.clampToken(tokenIndex);
    this.followState = followState;
    this.bumpRevision();
    return this.getState();
  }

  setManualAlignment(alignment: AlignmentResult) {
    this.alignment = alignment;
    this.currentTokenIndex = this.clampToken(alignment.tokenIndex);
    this.bumpRevision();
    return this.getState();
  }

  setFollowState(followState: FollowState) {
    this.followState = followState;
    this.bumpRevision();
    return this.getState();
  }

  resetTranscriptContext() {
    this.localAlignmentBuffer = createAlignmentBufferState();
    this.transcriptBuffer = [];
    this.lowConfidenceCount = 0;
    this.resyncArmed = false;
    this.lastFreshAnchor = null;
    this.manualAnchor = null;
    this.alignmentBufferDebug = { ...EMPTY_SESSION_ALIGNMENT_DEBUG };
  }

  armResync() {
    this.manualAnchor = null;
    this.resyncArmed = true;
    this.lowConfidenceCount = 0;
    this.followState = 'resyncing';
    this.bumpRevision();
    return this.getState();
  }

  hasFreshAnchor() {
    return Boolean(this.lastFreshAnchor);
  }

  getFreshAnchorTokenIndex() {
    return this.lastFreshAnchor?.tokenIndex ?? null;
  }

  setVisibleReacquireAnchor(anchor: VisibleReacquireAnchor, kind: 'startup' | 'manual') {
    this.manualAnchor = { ...anchor };
    this.localAlignmentBuffer = createAlignmentBufferState();
    this.transcriptBuffer = [];
    this.lowConfidenceCount = 0;
    this.resyncArmed = false;
    if (kind === 'manual' && this.followState !== 'manual' && this.followState !== 'paused') this.followState = 'holding';
    this.alignmentBufferDebug = {
      ...EMPTY_SESSION_ALIGNMENT_DEBUG,
      moveDecision: kind === 'startup'
        ? `startup visible anchor set at token ${anchor.visibleTokenIndex}`
        : `manual scroll detected; visible anchor token ${anchor.visibleTokenIndex}`,
      retentionDecision: 'reset',
      retentionReason: kind === 'startup'
        ? 'waiting for fresh transcript near the startup visible area'
        : 'waiting for fresh transcript near the visible manuscript area'
    };
    this.bumpRevision();
    return this.getState();
  }

  clearVisibleReacquireAnchor() {
    this.manualAnchor = null;
  }

  recordMovement(params: RecordMovementParams): MovementDecisionInfo {
    const tokenCount = this.model.tokens.length;
    const timestampMs = this.now?.() ?? Date.now();
    const lookahead = Math.max(0, Math.min(20, Math.round(this.displaySettings.readingLookaheadTokens ?? 0)));
    const confirmedTokenIndex = clamp(params.confirmedTokenIndex ?? params.result?.tokenIndex ?? this.currentTokenIndex, 0, Math.max(tokenCount - 1, 0));
    const proposedTargetTokenIndex = clamp(params.proposedTargetTokenIndex ?? proposedTargetFromLookahead(confirmedTokenIndex, lookahead, tokenCount), 0, Math.max(tokenCount - 1, 0));
    const previousAnchorTokenIndex = clamp(this.lastFreshAnchor?.tokenIndex ?? params.previousTokenIndex ?? this.currentTokenIndex, 0, Math.max(tokenCount - 1, 0));
    const elapsedSinceAnchorMs = this.lastFreshAnchor ? Math.max(0, timestampMs - this.lastFreshAnchor.timestampMs) : null;
    const confidence = params.confidence ?? params.result?.confidence ?? this.alignment.confidence;
    const engineReason = params.engineReason ?? params.result?.reason ?? this.alignment.reason;
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex, confirmedTokenIndex, proposedTargetTokenIndex,
      readingLookaheadTokens: lookahead, elapsedSinceAnchorMs, confidence,
      followState: params.followState, finalMovement: params.finalMovement,
      resultDiagnostics: params.result?.diagnostics ?? this.alignment.diagnostics,
      engineReason, alignmentContext: params.alignmentContext,
      tokensPerLine: estimateTokensPerLine(this.displaySettings.textWidthCh)
    });
    const decision: MovementDecisionInfo = {
      id: ++this.movementId,
      timestampMs,
      source: params.source,
      visibleAnchorTokenIndex: params.visibleAnchorTokenIndex ?? this.manualAnchor?.visibleTokenIndex,
      previousAnchorTokenIndex,
      previousAnchorSnippet: manuscriptTokenSnippet(this.model, previousAnchorTokenIndex),
      confirmedTokenIndex,
      confirmedSnippet: manuscriptTokenSnippet(this.model, confirmedTokenIndex),
      proposedTargetTokenIndex,
      proposedTargetSnippet: manuscriptTokenSnippet(this.model, proposedTargetTokenIndex),
      readingLookaheadTokens: lookahead,
      elapsedSinceAnchorMs,
      confidence,
      finalMovement: params.finalMovement,
      ...metrics
    };
    this.movementDecision = decision;
    this.movementHistory = [decision, ...this.movementHistory].slice(0, 10);
    if (params.markFreshAnchor) this.lastFreshAnchor = { tokenIndex: confirmedTokenIndex, timestampMs };
    return decision;
  }

  processTranscript(delta: TranscriptDelta): SessionTranscriptResult {
    const raw = delta.text;
    const words = transcriptToTokens(raw);
    const traces = [`recv ${delta.source}: raw="${raw}"`, `norm tokens: [${words.join(' ')}]`];
    this.latestTranscript = raw;
    if (words.length === 0) {
      const nextState = this.followState === 'manual' ? 'manual' : 'holding';
      this.followState = nextState;
      this.alignmentBufferDebug = {
        ...EMPTY_SESSION_ALIGNMENT_DEBUG, source: delta.source, rawTranscript: raw,
        moveDecision: 'held empty transcript', retentionDecision: 'discarded', retentionReason: 'empty transcript'
      };
      this.recordMovement({
        source: delta.source, previousTokenIndex: this.currentTokenIndex,
        confirmedTokenIndex: this.currentTokenIndex, followState: nextState,
        finalMovement: 'held', confidence: 0, engineReason: 'empty transcript',
        alignmentContext: 'discarded empty transcript'
      });
      traces.push('empty transcript -> holding');
      this.bumpRevision();
      return { state: this.getState(), traces, inputLevel: 0 };
    }

    if (delta.source === 'local-whisper') this.processLocalWhisper(delta, words, traces);
    else this.processStandardProvider(delta, words, traces);
    this.bumpRevision();
    return {
      state: this.getState(),
      traces,
      inputLevel: clamp(0.25 + words.length / 10, 0.25, 1)
    };
  }

  private processLocalWhisper(delta: TranscriptDelta, words: string[], traces: string[]) {
    const previousToken = this.currentTokenIndex;
    const wasResyncing = this.resyncArmed;
    const manualAnchor = this.manualAnchor;
    const decision = evaluateProvisionalAlignmentBuffer(
      this.model, this.localAlignmentBuffer, words, manualAnchor?.visibleTokenIndex ?? previousToken,
      {
        widenWindow: !manualAnchor && (wasResyncing || this.followState === 'lost'),
        backwardWindow: manualAnchor ? MANUAL_REACQUIRE_BACKWARD_WINDOW : undefined,
        forwardWindow: manualAnchor ? MANUAL_REACQUIRE_FORWARD_WINDOW : undefined
      }
    );
    this.localAlignmentBuffer = decision.state;
    this.resyncArmed = false;
    this.alignment = decision.result;
    this.transcriptBuffer = alignmentBufferTokens(decision.state);
    traces.push(
      `local eval buffer=[${decision.evaluationTokens.join(' ')}] provisional=[${decision.state.provisionalTokens.join(' ')}]`,
      `align matched="${decision.result.matchedText}" conf=${decision.result.confidence.toFixed(2)} deltaConf=${decision.deltaResult.confidence.toFixed(2)} | ${decision.result.reason}`,
      `context: ${decision.retainedDelta ? 'retained' : 'discarded'} (${decision.retentionReason}) retained=[${decision.retainedTokens.join(' ')}]`
    );

    let moved = false;
    let moveDecision = 'held';
    let movementFollowState = this.followState;
    let finalMovement: MovementDecisionOutcome = 'held';
    let movementContext = '';
    const freshHighConfidenceMatch = decision.moveRecommended && decision.result.confidence >= HIGH_CONFIDENCE;
    const nearManualAnchor = Boolean(manualAnchor && isNearManualVisibleAnchor(decision.result.tokenIndex, manualAnchor.visibleTokenIndex));
    const allowsBackward = Boolean(manualAnchor && visibleReacquireAllowsBackward(manualAnchor.source, manualAnchor.hadFreshConfirmedAnchor));
    const startupBackwardBlocked = Boolean(manualAnchor?.source === 'startup' && !allowsBackward && decision.result.tokenIndex < previousToken);
    const autoBackwardCandidate = shouldHoldAutomaticBackwardCandidate({
      candidateTokenIndex: decision.result.tokenIndex, confirmedAnchorTokenIndex: previousToken,
      explicitBackwardAllowed: wasResyncing, visibleReacquireAllowsBackward: allowsBackward
    });

    if (this.followState === 'manual' || this.followState === 'paused') {
      moveDecision = 'manual/paused: no follow update'; finalMovement = 'ignored'; movementContext = moveDecision;
      traces.push('manual/paused: moveToToken not called');
    } else if (manualAnchor) {
      if (freshHighConfidenceMatch && nearManualAnchor && !startupBackwardBlocked) {
        this.lowConfidenceCount = 0; this.followState = 'following'; movementFollowState = 'following';
        this.currentTokenIndex = this.clampToken(decision.result.tokenIndex); moved = true; finalMovement = 'accepted';
        if (manualAnchor.source === 'startup') {
          moveDecision = `cold-start reacquired from visible text at token ${decision.result.tokenIndex}`;
          movementContext = `cold-start reacquired from visible text; startup visible anchor token=${manualAnchor.visibleTokenIndex}`;
          traces.push(`cold-start reacquired from visible text visibleT=${manualAnchor.visibleTokenIndex} matchedT=${decision.result.tokenIndex}`);
        } else {
          moveDecision = `reacquired after manual scroll at token ${decision.result.tokenIndex}`;
          movementContext = `reacquired after manual scroll; visible anchor token=${manualAnchor.visibleTokenIndex}`;
          traces.push(`reacquired after manual scroll visibleT=${manualAnchor.visibleTokenIndex} matchedT=${decision.result.tokenIndex}`);
        }
        this.manualAnchor = null;
      } else {
        this.followState = 'holding'; movementFollowState = 'holding';
        if (startupBackwardBlocked) {
          moveDecision = `auto-backward candidate held: ${decision.result.tokenIndex} < confirmed ${previousToken}`;
          movementContext = 'auto-backward candidate held after startup; possible rollback/reread';
        } else if (manualAnchor.source === 'startup') {
          moveDecision = freshHighConfidenceMatch ? `held because startup match was outside visible neighborhood ${manualAnchor.visibleTokenIndex}` : `held: waiting for cold-start match near visible anchor ${manualAnchor.visibleTokenIndex}`;
          movementContext = freshHighConfidenceMatch ? `held because startup match was outside visible neighborhood; startup visible anchor token=${manualAnchor.visibleTokenIndex}` : `startup visible anchor reacquire pending; visible anchor token=${manualAnchor.visibleTokenIndex}`;
        } else {
          moveDecision = freshHighConfidenceMatch ? `held: high-confidence match not near visible anchor ${manualAnchor.visibleTokenIndex}` : `held: waiting to reacquire near visible anchor ${manualAnchor.visibleTokenIndex}`;
          movementContext = `manual scroll reacquire pending; visible anchor token=${manualAnchor.visibleTokenIndex}`;
        }
        traces.push(`moveToToken called: NO (${moveDecision})`);
      }
    } else if (freshHighConfidenceMatch && autoBackwardCandidate) {
      this.followState = 'holding'; movementFollowState = 'holding';
      moveDecision = `auto-backward candidate held: ${decision.result.tokenIndex} < confirmed ${previousToken}`;
      movementContext = 'auto-backward candidate held; possible rollback/reread';
      traces.push(`moveToToken called: NO (${moveDecision})`);
    } else if (freshHighConfidenceMatch) {
      this.lowConfidenceCount = 0;
      const nextState = stateFromAlignment(decision.result, previousToken, wasResyncing, 0);
      this.followState = nextState; movementFollowState = nextState;
      this.currentTokenIndex = this.clampToken(decision.result.tokenIndex); moved = true; finalMovement = 'accepted';
      moveDecision = `moved to token ${decision.result.tokenIndex} state=${nextState}`;
      movementContext = `accepted automatic movement state=${nextState}`;
      traces.push(`moveToToken called: YES s${decision.result.sentenceIndex} state=${nextState}`);
    } else {
      this.lowConfidenceCount += 1;
      const staleHighConfidence = decision.result.confidence >= HIGH_CONFIDENCE && !decision.moveRecommended;
      const nextState = staleHighConfidence ? 'holding' : stateFromAlignment(decision.result, previousToken, wasResyncing, this.lowConfidenceCount);
      this.followState = nextState; movementFollowState = nextState;
      moveDecision = staleHighConfidence ? 'held: current delta did not contribute a manuscript anchor' : `held state=${nextState} confidence below threshold`;
      movementContext = moveDecision;
      traces.push(staleHighConfidence ? `moveToToken called: NO state=${nextState} (stale context)` : `moveToToken called: NO state=${nextState} (low-conf)`);
    }

    this.recordMovement({
      source: delta.source, previousTokenIndex: previousToken, result: decision.result,
      followState: movementFollowState, finalMovement, engineReason: decision.result.reason,
      alignmentContext: `${movementContext || moveDecision}; ${decision.retainedDelta ? 'retained' : 'discarded'}: ${decision.retentionReason}`,
      markFreshAnchor: moved, visibleAnchorTokenIndex: manualAnchor?.visibleTokenIndex
    });
    this.alignmentBufferDebug = {
      source: delta.source, rawTranscript: delta.text, normalizedTokens: words,
      retainedTokens: decision.retainedTokens, rollingBufferTokens: decision.state.committedTokens,
      provisionalBufferTokens: decision.state.provisionalTokens, evaluationBufferTokens: decision.evaluationTokens,
      matchedText: decision.result.matchedText, confidence: decision.result.confidence,
      moveDecision, moveToTokenCalled: moved,
      retentionDecision: decision.retainedDelta ? 'retained' : 'discarded', retentionReason: decision.retentionReason
    };
  }

  private processStandardProvider(delta: TranscriptDelta, words: string[], traces: string[]) {
    this.transcriptBuffer = [...this.transcriptBuffer, ...words].slice(-28);
    const previousToken = this.currentTokenIndex;
    const wasResyncing = this.resyncArmed;
    const manualAnchor = this.manualAnchor;
    const result = alignTranscript(this.model, this.transcriptBuffer, manualAnchor?.visibleTokenIndex ?? previousToken, {
      widenWindow: !manualAnchor && (wasResyncing || this.followState === 'lost'),
      backwardWindow: manualAnchor ? MANUAL_REACQUIRE_BACKWARD_WINDOW : undefined,
      forwardWindow: manualAnchor ? MANUAL_REACQUIRE_FORWARD_WINDOW : undefined
    });
    this.alignment = result;
    this.resyncArmed = false;
    traces.push(`align matched="${result.matchedText}" conf=${result.confidence.toFixed(2)} s${result.sentenceIndex} p${result.paragraphIndex} t${result.tokenIndex} | ${result.reason}`);
    let moveDecision = 'held';
    let moved = false;
    let retentionReason = 'standard rolling buffer provider';
    let movementContext = 'standard rolling buffer provider';
    let movementState = this.followState;
    let finalMovement: MovementDecisionOutcome = 'held';

    if (this.followState === 'manual' || this.followState === 'paused') {
      moveDecision = 'manual/paused: no follow update'; finalMovement = 'ignored'; movementContext += '; manual/paused';
      traces.push('manual/paused: no follow update');
    } else {
      const highConfidence = result.confidence >= HIGH_CONFIDENCE;
      const nearAnchor = Boolean(manualAnchor && isNearManualVisibleAnchor(result.tokenIndex, manualAnchor.visibleTokenIndex));
      const allowsBackward = Boolean(manualAnchor && visibleReacquireAllowsBackward(manualAnchor.source, manualAnchor.hadFreshConfirmedAnchor));
      const startupBackwardBlocked = Boolean(manualAnchor?.source === 'startup' && !allowsBackward && result.tokenIndex < previousToken);
      const autoBackwardCandidate = shouldHoldAutomaticBackwardCandidate({
        candidateTokenIndex: result.tokenIndex, confirmedAnchorTokenIndex: previousToken,
        explicitBackwardAllowed: wasResyncing, visibleReacquireAllowsBackward: allowsBackward
      });
      if (manualAnchor) {
        if (highConfidence && nearAnchor && !startupBackwardBlocked) {
          this.lowConfidenceCount = 0; this.followState = 'following'; movementState = 'following';
          this.currentTokenIndex = this.clampToken(result.tokenIndex); moved = true; finalMovement = 'accepted';
          const startup = manualAnchor.source === 'startup';
          moveDecision = startup ? `cold-start reacquired from visible text at token ${result.tokenIndex}` : `reacquired after manual scroll at token ${result.tokenIndex}`;
          movementContext = startup ? `cold-start reacquired from visible text; startup visible anchor token=${manualAnchor.visibleTokenIndex}` : `reacquired after manual scroll; visible anchor token=${manualAnchor.visibleTokenIndex}`;
          retentionReason = startup ? 'fresh high-confidence match near startup visible anchor' : 'fresh high-confidence match near visible manual anchor';
          traces.push(startup ? `cold-start reacquired from visible text visibleT=${manualAnchor.visibleTokenIndex} matchedT=${result.tokenIndex}` : `reacquired after manual scroll visibleT=${manualAnchor.visibleTokenIndex} matchedT=${result.tokenIndex}`);
          this.manualAnchor = null;
        } else {
          this.followState = 'holding'; movementState = 'holding';
          moveDecision = startupBackwardBlocked
            ? `auto-backward candidate held: ${result.tokenIndex} < confirmed ${previousToken}`
            : manualAnchor.source === 'startup'
              ? highConfidence ? `held because startup match was outside visible neighborhood ${manualAnchor.visibleTokenIndex}` : `held: waiting for cold-start match near visible anchor ${manualAnchor.visibleTokenIndex}`
              : highConfidence ? `held: high-confidence match not near visible anchor ${manualAnchor.visibleTokenIndex}` : `held: waiting to reacquire near visible anchor ${manualAnchor.visibleTokenIndex}`;
          movementContext = startupBackwardBlocked ? 'auto-backward candidate held after startup; possible rollback/reread' : manualAnchor.source === 'startup' ? highConfidence ? `held because startup match was outside visible neighborhood; startup visible anchor token=${manualAnchor.visibleTokenIndex}` : `startup visible anchor reacquire pending; visible anchor token=${manualAnchor.visibleTokenIndex}` : `manual scroll reacquire pending; visible anchor token=${manualAnchor.visibleTokenIndex}`;
          retentionReason = manualAnchor.source === 'startup' ? 'waiting for fresh high-confidence match near startup visible anchor' : 'waiting for fresh high-confidence match near visible manual anchor';
          traces.push(`action: HELD (${moveDecision})`);
        }
      } else if (highConfidence && autoBackwardCandidate) {
        this.followState = 'holding'; movementState = 'holding';
        moveDecision = `auto-backward candidate held: ${result.tokenIndex} < confirmed ${previousToken}`;
        movementContext = 'auto-backward candidate held; possible rollback/reread';
        retentionReason = 'automatic backward movement disabled during live following';
        traces.push(`action: HELD (${moveDecision})`);
      } else if (highConfidence) {
        this.lowConfidenceCount = 0;
        const nextState = stateFromAlignment(result, previousToken, wasResyncing, 0);
        this.followState = nextState; movementState = nextState;
        this.currentTokenIndex = this.clampToken(result.tokenIndex); moved = true; finalMovement = 'accepted';
        moveDecision = `moved to token ${result.tokenIndex} state=${nextState}`;
        traces.push(`action: MOVED s${result.sentenceIndex} state=${nextState} (high-conf)`);
      } else {
        this.lowConfidenceCount += 1;
        const nextState = stateFromAlignment(result, previousToken, wasResyncing, this.lowConfidenceCount);
        this.followState = nextState; movementState = nextState;
        moveDecision = `held state=${nextState} confidence below threshold`;
        traces.push(`action: HELD state=${nextState} (low-conf)`);
      }
    }

    this.recordMovement({
      source: delta.source, previousTokenIndex: previousToken, result,
      followState: movementState, finalMovement, engineReason: result.reason,
      alignmentContext: movementContext, markFreshAnchor: moved,
      visibleAnchorTokenIndex: manualAnchor?.visibleTokenIndex
    });
    this.alignmentBufferDebug = {
      source: delta.source, rawTranscript: delta.text, normalizedTokens: words, retainedTokens: words,
      rollingBufferTokens: this.transcriptBuffer, provisionalBufferTokens: [], evaluationBufferTokens: this.transcriptBuffer,
      matchedText: result.matchedText, confidence: result.confidence, moveDecision, moveToTokenCalled: moved,
      retentionDecision: 'retained', retentionReason
    };
  }

  private clampToken(tokenIndex: number) {
    return clamp(tokenIndex, 0, Math.max(this.model.tokens.length - 1, 0));
  }

  private bumpRevision() {
    this.sessionRevision += 1;
  }
}
