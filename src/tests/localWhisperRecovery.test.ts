import { describe, expect, it } from 'vitest';
import { SessionCoordinator } from '../session/SessionCoordinator';
import { buildManuscript } from '../domain/manuscript';
import { transcriptToTokens } from '../domain/normalize';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';

// Invented workshop notes. No production manuscript or recorded transcript.
const intro = 'Workshop briefing. The observer keeps a careful journal of each morning expedition and records the temperature before breakfast. Every afternoon the team reviews its findings and prepares another route for tomorrow.';
const script = `${intro} Celis Norvale (pronounced like celery but with an s at the end). Apprentice of an experienced navigator, thoughtful and patient but never timid. She checks the bearings and weather before departure.`;
const spoken = `${intro} Celus Norvale prevent oh celery Norvale pronounced oh Celus Norvale pronounced like celery but with an ass at the end apprentice of an experienced navigator thoughtful and patient but never timid she checks the bearings and weather before departure`;
const delta = (text: string, timestampMs = 10_000) => ({ text, source: 'local-whisper' as const, isFinal: true, timestampMs });
function create(text = script) {
  return new SessionCoordinator({ manuscript: buildManuscript(text), currentTokenIndex: 0, followState: 'following', displaySettings: DEFAULT_DISPLAY_SETTINGS });
}

describe('Local Whisper lost recovery', () => {
  it('recovers from pronunciation retakes while recent evidence still overlaps the old anchor, then keeps progressing', () => {
    const coordinator = create();
    const words = transcriptToTokens(spoken);
    const states = [];
    for (let i = 0; i < words.length; i += 2) states.push(coordinator.processTranscript(delta(words.slice(i, i + 2).join(' '))).state);
    expect(states[20].followState).toBe('lost');
    expect(states[20].currentTokenIndex).toBe(35);
    expect(states[25].currentTokenIndex).toBe(35);
    expect(states[25].alignmentBufferDebug.reacquireAttempt?.failedChecks).toContain('forward-evidence');
    // Forward, distinctive evidence is available by "experienced navigator";
    // requiring the whole candidate to start beyond the anchor freezes here.
    expect(states[27].currentTokenIndex).toBe(47);
    expect(states[27].alignmentBufferDebug.reacquireEvent).toBe('accepted');
    expect(states.at(-1)?.currentTokenIndex).toBe(buildManuscript(script).tokens.length - 1);
    expect(states.at(-1)?.followState).toBe('following');
  });

  it('keeps attempted recovery distinct from a subsequent accepted ordinary alignment', () => {
    const coordinator = create('The studio light blinked once and Mara took her place beside the microphone.');
    coordinator.processTranscript(delta('The studio light blinked once'));
    coordinator.setFollowState('lost');
    const { state } = coordinator.processTranscript(delta('and Mara took'));
    expect(state.movementDecision?.finalMovement).toBe('accepted');
    expect(state.alignmentBufferDebug.moveToTokenCalled).toBe(true);
    expect(state.alignmentBufferDebug.reacquireAttempt?.accepted).toBe(false);
    expect(state.alignmentBufferDebug.reacquireAttempt?.candidate).toBeNull();
    expect(state.alignmentBufferDebug.reacquireAttempt?.evidenceTokens).toEqual(['and', 'mara', 'took']);
    expect(state.alignmentBufferDebug.rejectionCategory).toBeUndefined();
    coordinator.setFollowState('lost');
    const next = coordinator.processTranscript(delta('her place beside')).state;
    expect(next.alignmentBufferDebug.reacquireAttempt?.evidenceTokens).toEqual(['her', 'place', 'beside']);
  });

  it('retains actual rejected candidate and evidence without overwriting the final held outcome', () => {
    const coordinator = create();
    const words = transcriptToTokens(spoken);
    let state = coordinator.getState();
    for (let i = 0; i <= 48; i += 2) state = coordinator.processTranscript(delta(words.slice(i, i + 2).join(' '))).state;
    const attempt = state.alignmentBufferDebug.reacquireAttempt;
    expect(attempt?.accepted).toBe(false);
    expect(attempt?.candidate?.diagnostics?.selectedCandidateStartTokenIndex).toBe(34);
    expect(attempt?.candidate?.tokenIndex).toBe(41);
    expect(attempt?.evidenceTokens).toHaveLength(8);
    expect(attempt?.failedChecks).toContain('forward-progress');
    expect(state.currentTokenIndex).toBe(35);
    expect(state.alignmentBufferDebug.moveToTokenCalled).toBe(false);
    expect(state.movementDecision?.finalMovement).toBe('held');
  });

  it('retains accepted recovery evidence after clearing the live recovery buffer', () => {
    const text = 'Alpha beacon opens the first scripted sentence clearly. This sentence is deliberately skipped entirely by the narrator. Later orchard lantern harbor violet quartz follows with distinctive exact words. Finally the closing sentence ends.';
    const coordinator = create(text);
    coordinator.processTranscript(delta('Alpha beacon opens the first scripted sentence clearly'));
    for (const text of ['Later orchard lantern', 'harbor violet quartz', 'follows with distinctive exact words']) coordinator.processTranscript(delta(text));
    const { state } = coordinator.processTranscript(delta('Later orchard lantern harbor violet quartz follows with distinctive exact words'));
    expect(state.alignmentBufferDebug.reacquireAttempt?.accepted).toBe(true);
    expect(state.alignmentBufferDebug.evaluationBufferTokens.length).toBeGreaterThanOrEqual(8);
    expect(state.alignmentBufferDebug.newDeltaDistinctiveMatchedWordCount).toBeGreaterThanOrEqual(3);
    expect(state.alignmentBufferDebug.moveToTokenCalled).toBe(true);
    expect(state.movementDecision?.finalMovement).toBe('accepted');
  });

  it('holds genuinely ambiguous forward duplicates instead of bypassing recovery through ordinary alignment', () => {
    const phrase = 'Copper orchard lantern harbor violet quartz shimmer beside silver birches';
    const coordinator = create(`Quiet opening. ${phrase}. Several more neutral words separate the two locations. ${phrase}.`);
    coordinator.setFollowState('lost');
    const { state } = coordinator.processTranscript(delta(phrase));
    expect(state.alignmentBufferDebug.reacquireAttempt?.failedChecks).toContain('ambiguity');
    expect(state.currentTokenIndex).toBe(0);
    expect(state.alignmentBufferDebug.moveToTokenCalled).toBe(false);
    expect(state.movementDecision?.finalMovement).toBe('held');
    expect(state.transcriptBuffer).toEqual([]);
  });

  it('does not use an overlapping retake to roll back to an earlier duplicate', () => {
    const phrase = 'Copper orchard lantern harbor violet quartz shimmer beside silver birches';
    const model = buildManuscript(`${phrase}. A marked boundary separates the passages. ${phrase}.`);
    const coordinator = new SessionCoordinator({ manuscript: model, currentTokenIndex: 16, followState: 'lost', displaySettings: DEFAULT_DISPLAY_SETTINGS });
    const { state } = coordinator.processTranscript(delta(phrase));
    expect(state.currentTokenIndex).toBe(16);
    expect(state.alignmentBufferDebug.moveToTokenCalled).toBe(false);
  });
});
