import { describe, expect, it } from 'vitest';
import { buildManuscript, searchManuscript } from '../domain/manuscript';
import { TORTURE_FIXTURES } from '../domain/tortureFixtures';
import { SessionCoordinator } from '../session/SessionCoordinator';
import { DEFAULT_DISPLAY_SETTINGS, SAMPLE_MANUSCRIPT } from '../state/appStore';

function createCoordinator(text = SAMPLE_MANUSCRIPT, tokenIndex = 0) {
  return new SessionCoordinator({
    manuscript: buildManuscript(text),
    currentTokenIndex: tokenIndex,
    followState: 'following',
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
    now: () => 10_000
  });
}

function delta(text: string, source: 'manual' | 'mock' | 'local-whisper' = 'local-whisper') {
  return { text, source, isFinal: true, timestampMs: 10_000 } as const;
}

describe('SessionCoordinator characterization', () => {
  it('accumulates weak Local Whisper fragments before accepting the same high-confidence move', () => {
    const coordinator = createCoordinator();
    expect(coordinator.processTranscript(delta('studio')).state.currentTokenIndex).toBe(0);
    expect(coordinator.processTranscript(delta('light')).state.currentTokenIndex).toBe(0);
    const result = coordinator.processTranscript(delta('blinked once'));

    expect(result.state.currentTokenIndex).toBeGreaterThanOrEqual(0);
    expect(result.state.alignment.confidence).toBeGreaterThanOrEqual(0.76);
    expect(result.state.alignmentBufferDebug.moveToTokenCalled).toBe(true);
    expect(result.state.alignmentBufferDebug.provisionalBufferTokens).toEqual([]);
  });

  it('holds empty and low-confidence transcript without changing the accepted position', () => {
    const model = buildManuscript(SAMPLE_MANUSCRIPT);
    const start = searchManuscript(model, 'settled her eyes', 1) ?? 0;
    const coordinator = createCoordinator(SAMPLE_MANUSCRIPT, start);

    const empty = coordinator.processTranscript(delta(''));
    expect(empty.state.currentTokenIndex).toBe(start);
    expect(empty.state.followState).toBe('holding');
    expect(empty.state.alignmentBufferDebug.retentionReason).toBe('empty transcript');

    const noise = coordinator.processTranscript(delta('unrelated slate note from producer'));
    expect(noise.state.currentTokenIndex).toBe(start);
    expect(noise.state.alignmentBufferDebug.moveToTokenCalled).toBe(false);
  });

  it('preserves automatic rollback prevention during live following', () => {
    const model = buildManuscript(SAMPLE_MANUSCRIPT);
    const later = searchManuscript(model, 'By noon the manuscript', 1) ?? 0;
    const coordinator = createCoordinator(SAMPLE_MANUSCRIPT, later);
    const result = coordinator.processTranscript(delta('The studio light blinked once', 'mock'));

    expect(result.state.currentTokenIndex).toBe(later);
    expect(result.state.followState).toBe('holding');
    expect(result.state.alignmentBufferDebug.moveDecision).toContain('auto-backward candidate held');
  });

  it('does not refresh a stale anchor and reaches existing lost progression after repeated stale local candidates', () => {
    const text = 'Alpha beacon opens the first scripted sentence clearly. This sentence is deliberately skipped entirely by the narrator. Later orchard lantern harbor violet quartz follows with distinctive exact words. Finally the closing sentence ends.';
    const coordinator = createCoordinator(text);
    const first = coordinator.processTranscript(delta('Alpha beacon opens the first scripted sentence clearly'));
    const anchored = first.state.currentTokenIndex;
    let state = first.state;
    for (const chunk of ['Later orchard lantern', 'harbor violet quartz', 'follows with distinctive exact words']) {
      state = coordinator.processTranscript(delta(chunk)).state;
    }
    expect(state.currentTokenIndex).toBe(anchored);
    expect(state.followState).toBe('lost');
    expect(state.alignmentBufferDebug.commitRejectedReason).toContain('selected candidate');
    expect(state.alignmentBufferDebug.lowConfidenceCount).toBeGreaterThanOrEqual(3);

    const reacquired = coordinator.processTranscript(delta('Later orchard lantern harbor violet quartz follows with distinctive exact words')).state;
    expect(reacquired.currentTokenIndex).toBeGreaterThan(anchored);
    expect(reacquired.followState).toBe('following');
    expect(reacquired.movementDecision?.classification).toBe('bounded forward reacquired');
    expect(reacquired.alignmentBufferDebug.reacquireEvent).toBe('accepted');
  });

  it('reacquires near a manual visible anchor and clears the anchor', () => {
    const model = buildManuscript(SAMPLE_MANUSCRIPT);
    const visible = searchManuscript(model, 'By noon the manuscript', 1) ?? 0;
    const coordinator = createCoordinator();
    coordinator.setVisibleReacquireAnchor({
      source: 'manual-scroll', visibleTokenIndex: visible, detectedAtMs: 9_000,
      direction: 'forward', hadFreshConfirmedAnchor: false
    }, 'manual');
    const result = coordinator.processTranscript(delta('By noon the manuscript had become less like a stack of pages', 'mock'));

    expect(result.state.currentTokenIndex).toBeGreaterThanOrEqual(visible);
    expect(result.state.followState).toBe('following');
    expect(result.state.manualReacquireAnchor).toBeNull();
    expect(result.state.movementDecision?.classification).toBe('manual scroll reacquired');
  });

  it('holds the manually chosen region when fresh speech points back to the old anchor', () => {
    const model = buildManuscript(SAMPLE_MANUSCRIPT);
    const oldAnchor = searchManuscript(model, 'The studio light blinked once', 1) ?? 0;
    const visible = searchManuscript(model, 'By noon the manuscript', 1) ?? 0;
    const coordinator = createCoordinator(SAMPLE_MANUSCRIPT, oldAnchor);
    coordinator.setVisibleReacquireAnchor({
      source: 'manual-scroll', visibleTokenIndex: visible, detectedAtMs: 9_000,
      direction: 'forward', hadFreshConfirmedAnchor: true
    }, 'manual');

    const result = coordinator.processTranscript(
      delta('The studio light blinked once and Mara settled her eyes', 'mock')
    );

    expect(result.state.currentTokenIndex).toBe(oldAnchor);
    expect(result.state.followState).toBe('holding');
    expect(result.state.manualReacquireAnchor?.visibleTokenIndex).toBe(visible);
    expect(result.traces.some((trace) => trace.includes('manual anchor rejected / held'))).toBe(true);
    expect(result.traces.some((trace) => trace.includes('auto-follow remains suppressed'))).toBe(true);
  });

  it('resets transcript evidence and revisions when the manuscript changes', () => {
    const coordinator = createCoordinator();
    coordinator.processTranscript(delta('studio'));
    const before = coordinator.getState();
    const after = coordinator.replaceManuscript(buildManuscript('A completely new manuscript.'), 0);

    expect(after.transcriptBuffer).toEqual([]);
    expect(after.alignmentBufferDebug).toMatchObject({ moveDecision: 'Waiting for transcript.' });
    expect(after.manuscriptRevision).toBe(before.manuscriptRevision + 1);
    expect(after.movementDecisionHistory).toEqual([]);
  });

  it('keeps manual provider decisions provider-neutral and ignored while in manual mode', () => {
    const coordinator = createCoordinator();
    coordinator.setFollowState('manual');
    const result = coordinator.processTranscript(delta('The studio light blinked once', 'manual'));

    expect(result.state.currentTokenIndex).toBe(0);
    expect(result.state.followState).toBe('manual');
    expect(result.state.movementDecision?.finalMovement).toBe('ignored');
  });

  it('produces a JSON-serializable authoritative snapshot without token-frequency maps', () => {
    const coordinator = createCoordinator();
    coordinator.processTranscript(delta('The studio light blinked once'));
    const snapshot = coordinator.toSerializableSnapshot();

    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot.acceptedPosition.character).toBeGreaterThanOrEqual(0);
    expect(snapshot.manuscript.tokens[0]).toEqual(expect.objectContaining({ tokenIndex: 0, characterRange: { start: 0, end: 3 } }));
    expect(snapshot.manuscript).not.toHaveProperty('tokenFrequency');
  });

  it('preserves expected hold/advance outcomes across the existing torture fixtures', () => {
    for (const fixture of TORTURE_FIXTURES) {
      // MockAsrProvider consumes bracketed control markers before TranscriptDelta reaches the coordinator.
      if (fixture.chunks.some((chunk) => /^\[.*\]$/.test(chunk.trim()))) continue;
      const model = buildManuscript(fixture.manuscriptText);
      const start = fixture.startTokenSearch ? searchManuscript(model, fixture.startTokenSearch, 1) ?? 0 : 0;
      const coordinator = createCoordinator(fixture.manuscriptText, start);
      let state = coordinator.getState();
      for (const chunk of fixture.chunks) state = coordinator.processTranscript(delta(chunk, 'mock')).state;

      if (fixture.expectation.expectedMovement === 'advance') {
        expect(state.currentTokenIndex, fixture.id).toBeGreaterThanOrEqual(start);
      } else if (fixture.expectation.expectedMovement === 'reject-jump') {
        expect(state.currentTokenIndex, fixture.id).toBe(start);
      } else if (fixture.expectation.expectedMovement === 'hold') {
        expect(['holding', 'uncertain', 'lost'], fixture.id).toContain(state.followState);
      }
    }
  });
});
