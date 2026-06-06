import { describe, expect, it } from 'vitest';
import { TORTURE_FIXTURES, TORTURE_MANUSCRIPT } from '../domain/tortureFixtures';
import {
  createTortureHarnessState,
  findTortureStartToken,
  runTortureSequence
} from '../domain/tortureHarness';
import { buildManuscript } from '../domain/manuscript';
import { transcriptToTokens } from '../domain/normalize';
import type { TortureFixtureCase } from '../domain/tortureFixtures';
import type { TortureRunOutcome, TortureStepReport } from '../domain/tortureHarness';

function runFixture(fixture: TortureFixtureCase) {
  const model = buildManuscript(fixture.manuscriptText);
  const startToken = findTortureStartToken(
    model,
    fixture.startTokenSearch,
    fixture.startTokenSearchOccurrence ?? 0
  );
  const outcome = runTortureSequence(
    model,
    fixture.chunks,
    createTortureHarnessState(model, startToken, 'following')
  );

  return {
    model,
    startToken,
    outcome,
    finalReport: outcome.reports.at(-1)
  };
}

function expectMovement(
  movement: TortureFixtureCase['expectation']['expectedMovement'],
  finalReport: TortureStepReport,
  outcome: TortureRunOutcome,
  startToken: number
) {
  const previousToken = finalReport.previousManuscriptPosition.tokenIndex;
  const newToken = finalReport.newManuscriptPosition.tokenIndex;

  if (movement === 'advance') {
    expect(finalReport.moved).toBe(true);
    expect(newToken).toBeGreaterThan(previousToken);
    expect(outcome.finalState.currentTokenIndex).toBeGreaterThanOrEqual(startToken);
  } else if (movement === 'hold') {
    expect(finalReport.moved).toBe(false);
    expect(newToken).toBe(previousToken);
  } else if (movement === 'move-backward') {
    expect(finalReport.moved).toBe(true);
    expect(newToken).toBeLessThan(previousToken);
    expect(outcome.finalState.currentTokenIndex).toBeLessThan(startToken);
  } else {
    expect(finalReport.moved).toBe(false);
    expect(newToken).toBe(previousToken);
    expect(outcome.finalState.currentTokenIndex).toBe(startToken);
  }
}

describe('alignment torture-test fixtures', () => {
  for (const fixture of TORTURE_FIXTURES) {
    it(fixture.label, () => {
      const { startToken, outcome, finalReport } = runFixture(fixture);

      expect(finalReport).toBeDefined();
      if (!finalReport) return;

      const { expectation } = fixture;

      expect(finalReport.appState).toBe(expectation.expectedState);
      expect(finalReport.diagnosticCode).toBe(expectation.diagnosticCode);
      expect(finalReport.reason).toContain(expectation.reasonIncludes);
      expectMovement(expectation.expectedMovement, finalReport, outcome, startToken);

      if (expectation.retakeBiasApplied !== undefined) {
        expect(finalReport.alignmentDiagnostics.retakeBiasApplied).toBe(expectation.retakeBiasApplied);
      }

      if (expectation.duplicateJumpPenaltyApplied !== undefined) {
        expect(finalReport.alignmentDiagnostics.duplicateJumpPenaltyApplied).toBe(
          expectation.duplicateJumpPenaltyApplied
        );
      }

      if (expectation.duplicateJumpCandidateRejected !== undefined) {
        expect(finalReport.alignmentDiagnostics.duplicateJumpCandidateRejected).toBe(
          expectation.duplicateJumpCandidateRejected
        );
      }

      if (expectation.minFinalConfidence !== undefined) {
        expect(finalReport.confidenceScore).toBeGreaterThanOrEqual(expectation.minFinalConfidence);
      }

      if (expectation.maxFinalConfidence !== undefined) {
        expect(finalReport.confidenceScore).toBeLessThanOrEqual(expectation.maxFinalConfidence);
      }

      if (expectation.matchedTextIncludes) {
        expect(finalReport.bestManuscriptMatch.toLowerCase()).toContain(
          expectation.matchedTextIncludes.toLowerCase()
        );
      }
    });
  }

  it('runs a multi-chunk reading sequence and lands on the expected final manuscript token', () => {
    const model = buildManuscript(TORTURE_MANUSCRIPT);
    const startToken = findTortureStartToken(model, 'the amber recorder clicked twice');
    const finalPhrase = 'lina read the first line with an even voice';
    const finalPhraseStart = findTortureStartToken(model, finalPhrase);
    const expectedFinalToken = finalPhraseStart + transcriptToTokens(finalPhrase).length - 1;
    const outcome = runTortureSequence(
      model,
      [
        'The amber recorder clicked twice',
        'and Lina began the test',
        'Lina read the first line with an even voice'
      ],
      createTortureHarnessState(model, startToken, 'following')
    );
    const finalReport = outcome.reports.at(-1);

    expect(finalReport).toBeDefined();
    expect(outcome.reports).toHaveLength(3);
    expect(outcome.finalState.followState).toBe('following');
    expect(outcome.finalState.currentTokenIndex).toBe(expectedFinalToken);
    expect(finalReport?.newManuscriptPosition.tokenIndex).toBe(expectedFinalToken);
    expect(finalReport?.reason).toContain('Moved on high confidence');
  });
});
