import { HIGH_CONFIDENCE } from './scrollModel.js';
import type { AlignmentResult, FollowState } from './types.js';

export const DIAGNOSTIC_BASELINE_WPM = 160;

export type MovementProgressCorridor = 'inside' | 'near' | 'outside' | 'unknown';

export type MovementDecisionClassification =
  | 'on-track'
  | 'small local correction'
  | 'plausible forward movement'
  | 'suspicious forward jump'
  | 'local rollback / retake'
  | 'suspicious rollback'
  | 'startup visible anchor'
  | 'cold-start reacquired'
  | 'manual scroll anchor'
  | 'manual scroll reacquired'
  | 'held / stale / uncertain';

export type MovementDecisionOutcome =
  | 'accepted'
  | 'held'
  | 'ignored'
  | 'corrected'
  | 'only Assist-cruised';

export type MovementDecisionInfo = {
  id: number;
  timestampMs: number;
  source: string;
  visibleAnchorTokenIndex?: number;
  previousAnchorTokenIndex: number;
  previousAnchorSnippet: string;
  confirmedTokenIndex: number;
  confirmedSnippet: string;
  proposedTargetTokenIndex: number;
  proposedTargetSnippet: string;
  movementDeltaTokens: number;
  movementDeltaLines: number;
  readingLookaheadTokens: number;
  elapsedSinceAnchorMs: number | null;
  baselineWpm: number;
  expectedTokenProgress: number | null;
  expectedProgressCorridor: MovementProgressCorridor;
  classification: MovementDecisionClassification;
  confidence: number;
  penaltySummary: string;
  alignmentContext: string;
  finalMovement: MovementDecisionOutcome;
  reason: string;
  engineReason: string;
};

export type MovementDecisionDiagnosticInput = {
  previousAnchorTokenIndex: number;
  confirmedTokenIndex: number;
  proposedTargetTokenIndex: number;
  readingLookaheadTokens: number;
  elapsedSinceAnchorMs: number | null;
  confidence: number;
  followState: FollowState;
  finalMovement: MovementDecisionOutcome;
  resultDiagnostics?: AlignmentResult['diagnostics'];
  engineReason?: string;
  alignmentContext?: string;
  baselineWpm?: number;
  tokensPerLine?: number;
  highConfidenceThreshold?: number;
};

export type MovementDecisionMetrics = Pick<
  MovementDecisionInfo,
  | 'movementDeltaTokens'
  | 'movementDeltaLines'
  | 'baselineWpm'
  | 'expectedTokenProgress'
  | 'expectedProgressCorridor'
  | 'classification'
  | 'penaltySummary'
  | 'reason'
  | 'alignmentContext'
  | 'engineReason'
>;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampReadingLookahead(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value ?? 0), 0, 20);
}

export function proposedTargetFromLookahead(
  confirmedTokenIndex: number,
  readingLookaheadTokens: number,
  tokenCount: number
) {
  if (tokenCount <= 0) return 0;
  return clamp(
    Math.round(confirmedTokenIndex) + clampReadingLookahead(readingLookaheadTokens),
    0,
    tokenCount - 1
  );
}

export function estimateTokensPerLine(textWidthCh: number | undefined) {
  if (!Number.isFinite(textWidthCh)) return 10;
  return clamp(Math.round((textWidthCh ?? 64) / 6), 6, 18);
}

export function expectedTokenProgressFromWpm(
  elapsedSinceAnchorMs: number | null,
  baselineWpm = DIAGNOSTIC_BASELINE_WPM
) {
  if (elapsedSinceAnchorMs === null || elapsedSinceAnchorMs < 0) return null;
  return (elapsedSinceAnchorMs / 60000) * baselineWpm;
}

export function classifyExpectedProgressCorridor(
  movementDeltaTokens: number,
  expectedTokenProgress: number | null
): MovementProgressCorridor {
  if (expectedTokenProgress === null || movementDeltaTokens < 0) return 'unknown';

  const insideAllowance = Math.max(8, expectedTokenProgress * 0.55);
  const nearAllowance = Math.max(22, expectedTokenProgress * 1.15);

  if (movementDeltaTokens <= expectedTokenProgress + insideAllowance) return 'inside';
  if (movementDeltaTokens <= expectedTokenProgress + nearAllowance) return 'near';
  return 'outside';
}

export function summarizePenaltySignals(
  diagnostics: AlignmentResult['diagnostics'] | undefined,
  engineReason = ''
) {
  const signals: string[] = [];
  if (diagnostics?.retakeBiasApplied) signals.push('retake bias applied');
  if (diagnostics?.duplicateJumpPenaltyApplied) signals.push('duplicate/jump penalty applied');
  if (diagnostics?.duplicateJumpCandidateRejected) signals.push('duplicate candidate rejected');
  if (engineReason.toLowerCase().includes('generic/short guard')) {
    signals.push('generic/common phrase guard');
  }
  if (diagnostics?.selectedDirection) signals.push(`selected ${diagnostics.selectedDirection}`);
  return signals.length > 0 ? signals.join('; ') : 'none reported';
}

export function classifyMovementDecision(
  input: MovementDecisionDiagnosticInput,
  movementDeltaTokens: number,
  expectedProgressCorridor: MovementProgressCorridor
): MovementDecisionClassification {
  const threshold = input.highConfidenceThreshold ?? HIGH_CONFIDENCE;
  const absDelta = Math.abs(movementDeltaTokens);
  const diagnostics = input.resultDiagnostics;
  const alignmentContext = input.alignmentContext?.toLowerCase() ?? '';

  if (alignmentContext.includes('cold-start reacquired from visible text')) {
    return 'cold-start reacquired';
  }
  if (alignmentContext.includes('startup visible anchor set')) {
    return 'startup visible anchor';
  }
  if (alignmentContext.includes('reacquired after manual scroll')) {
    return 'manual scroll reacquired';
  }
  if (alignmentContext.includes('manual scroll detected')) {
    return 'manual scroll anchor';
  }

  if (
    input.finalMovement === 'ignored' ||
    input.confidence < 0.3 ||
    (input.finalMovement === 'held' &&
      input.confidence < threshold &&
      absDelta <= Math.max(8, input.readingLookaheadTokens + 4))
  ) {
    return 'held / stale / uncertain';
  }

  if (movementDeltaTokens < -8) {
    const localRollback =
      diagnostics?.selectedDirection === 'backward' ||
      diagnostics?.retakeBiasApplied ||
      absDelta <= 80;
    return localRollback ? 'local rollback / retake' : 'suspicious rollback';
  }

  if (absDelta <= Math.max(8, input.readingLookaheadTokens + 4)) {
    return 'on-track';
  }

  if (absDelta <= 28) {
    return 'small local correction';
  }

  if (movementDeltaTokens > 0) {
    if (expectedProgressCorridor === 'outside') return 'suspicious forward jump';
    if (expectedProgressCorridor === 'inside' || expectedProgressCorridor === 'near') {
      return 'plausible forward movement';
    }
    return movementDeltaTokens <= 60 ? 'plausible forward movement' : 'suspicious forward jump';
  }

  return 'held / stale / uncertain';
}

export function describeMovementDecision(
  input: MovementDecisionDiagnosticInput,
  classification: MovementDecisionClassification,
  expectedProgressCorridor: MovementProgressCorridor
) {
  const threshold = input.highConfidenceThreshold ?? HIGH_CONFIDENCE;
  const alignmentContext = input.alignmentContext?.toLowerCase() ?? '';

  if (classification === 'cold-start reacquired') {
    return 'cold-start reacquired from visible text near the startup anchor';
  }
  if (classification === 'startup visible anchor') {
    return 'startup visible anchor set: waiting for a fresh nearby match';
  }
  if (classification === 'manual scroll reacquired') {
    return 'reacquired after manual scroll near the visible anchor';
  }
  if (classification === 'manual scroll anchor') {
    return 'manual scroll detected: waiting for a fresh nearby match';
  }

  if (input.finalMovement === 'only Assist-cruised') {
    if (input.engineReason?.toLowerCase().includes('stale')) return 'stopped: no fresh anchor';
    if (input.engineReason?.toLowerCase().includes('low confidence')) return 'stopped: low confidence';
    if (input.engineReason?.toLowerCase().includes('lag')) return 'cruising: Assist slowed by lag warning';
    return 'cruising: Assist using recent anchor';
  }

  if (input.finalMovement === 'corrected') {
    return 'corrected: scroll target moved into the reading band';
  }

  if (input.finalMovement === 'ignored') {
    return input.followState === 'paused'
      ? 'ignored: following is paused'
      : 'ignored: manual mode is active';
  }

  if (input.finalMovement === 'held') {
    const engineReason = input.engineReason?.toLowerCase() ?? '';
    if (alignmentContext.includes('startup match was outside visible neighborhood')) {
      return 'held because startup match was outside visible neighborhood';
    }
    if (alignmentContext.includes('auto-backward candidate held')) {
      return 'held: auto-backward candidate treated as possible rollback/reread';
    }
    if (engineReason.includes('already in reading band')) return 'held: already in reading band';
    if (engineReason.includes('stale') || engineReason.includes('no fresh anchor')) {
      return 'stopped: no fresh anchor';
    }
    if (engineReason.includes('low confidence')) return 'stopped: low confidence';
    if (classification === 'suspicious forward jump' || expectedProgressCorridor === 'outside') {
      return 'held: proposed jump is far beyond expected pace';
    }
    if (input.confidence < threshold) return 'held: confidence below movement threshold';
    return 'held: confidence or context is stale';
  }

  if (classification === 'local rollback / retake') {
    return 'accepted rollback: local retake evidence';
  }

  if (classification === 'suspicious forward jump') {
    return 'accepted: high-confidence jump flagged as suspicious for review';
  }

  if (classification === 'small local correction') {
    return 'accepted: small local correction';
  }

  return 'accepted: local high-confidence progress';
}

export function buildMovementDecisionMetrics(
  input: MovementDecisionDiagnosticInput
): MovementDecisionMetrics {
  const baselineWpm = input.baselineWpm ?? DIAGNOSTIC_BASELINE_WPM;
  const tokensPerLine = Math.max(1, input.tokensPerLine ?? 10);
  const movementDeltaTokens = input.proposedTargetTokenIndex - input.previousAnchorTokenIndex;
  const movementDeltaLines = movementDeltaTokens / tokensPerLine;
  const expectedTokenProgress = expectedTokenProgressFromWpm(
    input.elapsedSinceAnchorMs,
    baselineWpm
  );
  const expectedProgressCorridor = classifyExpectedProgressCorridor(
    movementDeltaTokens,
    expectedTokenProgress
  );
  const classification = classifyMovementDecision(
    input,
    movementDeltaTokens,
    expectedProgressCorridor
  );

  return {
    movementDeltaTokens,
    movementDeltaLines,
    baselineWpm,
    expectedTokenProgress,
    expectedProgressCorridor,
    classification,
    penaltySummary: summarizePenaltySignals(input.resultDiagnostics, input.engineReason),
    reason: describeMovementDecision(input, classification, expectedProgressCorridor),
    alignmentContext: input.alignmentContext || 'not reported',
    engineReason: input.engineReason || 'not reported'
  };
}
