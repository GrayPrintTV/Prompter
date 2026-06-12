import { describe, expect, it } from 'vitest';
import {
  buildMovementDecisionMetrics,
  proposedTargetFromLookahead,
  summarizePenaltySignals
} from '../domain/movementDiagnostics';

describe('movement decision diagnostics', () => {
  it('shows reading lookahead in the proposed target token', () => {
    expect(proposedTargetFromLookahead(10, 0, 100)).toBe(10);
    expect(proposedTargetFromLookahead(10, 20, 100)).toBe(30);
    expect(proposedTargetFromLookahead(95, 20, 100)).toBe(99);
  });

  it('classifies plausible forward movement inside the diagnostic pace corridor', () => {
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 100,
      confirmedTokenIndex: 144,
      proposedTargetTokenIndex: 150,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 20_000,
      confidence: 0.88,
      followState: 'following',
      finalMovement: 'accepted',
      tokensPerLine: 10
    });

    expect(metrics.expectedProgressCorridor).toBe('inside');
    expect(metrics.classification).toBe('plausible forward movement');
    expect(metrics.reason).toBe('accepted: local high-confidence progress');
    expect(metrics.movementDeltaLines).toBeCloseTo(5);
  });

  it('flags a far forward candidate as suspicious without changing acceptance behavior', () => {
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 100,
      confirmedTokenIndex: 275,
      proposedTargetTokenIndex: 281,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 4_000,
      confidence: 0.86,
      followState: 'following',
      finalMovement: 'accepted',
      tokensPerLine: 10
    });

    expect(metrics.expectedProgressCorridor).toBe('outside');
    expect(metrics.classification).toBe('suspicious forward jump');
    expect(metrics.reason).toBe('accepted: high-confidence jump flagged as suspicious for review');
  });

  it('labels held far-forward candidates as rejected by the diagnostic corridor', () => {
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 100,
      confirmedTokenIndex: 275,
      proposedTargetTokenIndex: 281,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 4_000,
      confidence: 0.62,
      followState: 'holding',
      finalMovement: 'held',
      tokensPerLine: 10
    });

    expect(metrics.classification).toBe('suspicious forward jump');
    expect(metrics.reason).toBe('held: proposed jump is far beyond expected pace');
  });

  it('distinguishes local retakes from suspicious far rollbacks', () => {
    const localRetake = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 200,
      confirmedTokenIndex: 160,
      proposedTargetTokenIndex: 166,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 12_000,
      confidence: 0.9,
      followState: 'retake',
      finalMovement: 'accepted',
      resultDiagnostics: {
        retakeBiasApplied: true,
        duplicateJumpPenaltyApplied: false,
        duplicateJumpCandidateRejected: false,
        selectedDirection: 'backward'
      },
      tokensPerLine: 10
    });
    const farRollback = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 500,
      confirmedTokenIndex: 240,
      proposedTargetTokenIndex: 246,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 12_000,
      confidence: 0.9,
      followState: 'retake',
      finalMovement: 'accepted',
      tokensPerLine: 10
    });

    expect(localRetake.classification).toBe('local rollback / retake');
    expect(localRetake.reason).toBe('accepted rollback: local retake evidence');
    expect(farRollback.classification).toBe('suspicious rollback');
  });

  it('keeps low-confidence holds in the held/stale/uncertain bucket', () => {
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 100,
      confirmedTokenIndex: 101,
      proposedTargetTokenIndex: 107,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 8_000,
      confidence: 0.2,
      followState: 'holding',
      finalMovement: 'held',
      tokensPerLine: 10
    });

    expect(metrics.classification).toBe('held / stale / uncertain');
    expect(metrics.reason).toBe('held: confidence below movement threshold');
  });

  it('explains held automatic rollback candidates', () => {
    const metrics = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 200,
      confirmedTokenIndex: 170,
      proposedTargetTokenIndex: 176,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 5000,
      confidence: 0.9,
      followState: 'holding',
      finalMovement: 'held',
      alignmentContext: 'auto-backward candidate held; possible rollback/reread'
    });

    expect(metrics.classification).toBe('local rollback / retake');
    expect(metrics.reason).toContain('auto-backward candidate');
  });

  it('labels manual scroll anchors and successful reacquisition', () => {
    const detected = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 400,
      confirmedTokenIndex: 400,
      proposedTargetTokenIndex: 260,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 0,
      confidence: 0,
      followState: 'holding',
      finalMovement: 'held',
      alignmentContext: 'manual scroll detected; visible anchor token=260'
    });
    const reacquired = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 400,
      confirmedTokenIndex: 268,
      proposedTargetTokenIndex: 274,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: 2000,
      confidence: 0.9,
      followState: 'following',
      finalMovement: 'accepted',
      alignmentContext: 'reacquired after manual scroll; visible anchor token=260'
    });

    expect(detected.classification).toBe('manual scroll anchor');
    expect(detected.reason).toContain('manual scroll detected');
    expect(reacquired.classification).toBe('manual scroll reacquired');
    expect(reacquired.reason).toContain('reacquired after manual scroll');
  });

  it('distinguishes startup visible anchors and cold-start reacquisition', () => {
    const seeded = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 600,
      confirmedTokenIndex: 600,
      proposedTargetTokenIndex: 20,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: null,
      confidence: 0,
      followState: 'holding',
      finalMovement: 'held',
      alignmentContext: 'startup visible anchor set; visible anchor token=20'
    });
    const reacquired = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 600,
      confirmedTokenIndex: 28,
      proposedTargetTokenIndex: 34,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: null,
      confidence: 0.91,
      followState: 'following',
      finalMovement: 'accepted',
      alignmentContext: 'cold-start reacquired from visible text; startup visible anchor token=20'
    });
    const outside = buildMovementDecisionMetrics({
      previousAnchorTokenIndex: 600,
      confirmedTokenIndex: 420,
      proposedTargetTokenIndex: 426,
      readingLookaheadTokens: 6,
      elapsedSinceAnchorMs: null,
      confidence: 0.91,
      followState: 'holding',
      finalMovement: 'held',
      alignmentContext: 'held because startup match was outside visible neighborhood; startup visible anchor token=20'
    });

    expect(seeded.classification).toBe('startup visible anchor');
    expect(seeded.reason).toContain('startup visible anchor set');
    expect(reacquired.classification).toBe('cold-start reacquired');
    expect(reacquired.reason).toContain('cold-start reacquired');
    expect(outside.reason).toBe('held because startup match was outside visible neighborhood');
  });

  it('summarizes available retake, duplicate, and common-phrase penalty signals', () => {
    const summary = summarizePenaltySignals(
      {
        retakeBiasApplied: true,
        duplicateJumpPenaltyApplied: true,
        duplicateJumpCandidateRejected: true,
        selectedDirection: 'backward'
      },
      '4/5 words; generic/short guard; duplicate/jump penalty applied'
    );

    expect(summary).toContain('retake bias applied');
    expect(summary).toContain('duplicate/jump penalty applied');
    expect(summary).toContain('duplicate candidate rejected');
    expect(summary).toContain('generic/common phrase guard');
    expect(summary).toContain('selected backward');
  });
});
