import { describe, expect, it } from 'vitest';
import {
  alignmentBufferTokens,
  createAlignmentBufferState,
  evaluateProvisionalAlignmentBuffer
} from '../domain/alignmentBuffer';
import { buildManuscript } from '../domain/manuscript';
import { transcriptToTokens } from '../domain/normalize';
import { SAMPLE_MANUSCRIPT } from '../state/appStore';

function applyDelta(
  text: string,
  state = createAlignmentBufferState(),
  currentTokenIndex = 0
) {
  return evaluateProvisionalAlignmentBuffer(
    buildManuscript(SAMPLE_MANUSCRIPT),
    state,
    transcriptToTokens(text),
    currentTokenIndex
  );
}

describe('Local Whisper provisional alignment buffer', () => {
  it('lets weak manuscript anchors accumulate into a high-confidence move', () => {
    let state = createAlignmentBufferState();

    let decision = applyDelta('studio', state);
    state = decision.state;
    expect(decision.moveRecommended).toBe(false);
    expect(decision.retainedDelta).toBe(true);
    expect(state.provisionalTokens).toEqual(['studio']);

    decision = applyDelta('light', state);
    state = decision.state;
    expect(decision.moveRecommended).toBe(false);
    expect(decision.retainedDelta).toBe(true);
    expect(state.provisionalTokens).toEqual(['studio', 'light']);

    decision = applyDelta('blinked once', state);
    expect(decision.moveRecommended).toBe(true);
    expect(decision.result.confidence).toBeGreaterThanOrEqual(0.76);
    expect(decision.result.matchedText.toLowerCase()).toContain('studio light blinked once');
    expect(decision.state.committedTokens.join(' ')).toContain('studio light blinked once');
    expect(decision.state.provisionalTokens).toEqual([]);
  });

  it('discards off-script commentary without poisoning alignment evidence', () => {
    let decision = applyDelta('studio');
    let state = decision.state;

    decision = applyDelta('this is a pickup', state);
    state = decision.state;
    expect(decision.retainedDelta).toBe(false);
    expect(alignmentBufferTokens(state).join(' ')).not.toContain('pickup');
    expect(state.provisionalTokens).toEqual(['studio']);

    decision = applyDelta('you are just sitting there', state);
    state = decision.state;
    expect(decision.retainedDelta).toBe(false);
    expect(alignmentBufferTokens(state).join(' ')).not.toContain('sitting');

    decision = applyDelta('almost real time pretty cool', state);
    state = decision.state;
    expect(decision.retainedDelta).toBe(false);
    expect(decision.clearedProvisional).toBe(true);
    expect(state.provisionalTokens).toEqual([]);
  });

  it('does not move from stale committed context when the current delta is off-script', () => {
    let decision = applyDelta('studio');
    decision = applyDelta('light', decision.state);
    decision = applyDelta('blinked once', decision.state);
    const state = decision.state;

    decision = applyDelta('this is a pickup ignore me', state, decision.result.tokenIndex);

    expect(decision.retainedDelta).toBe(false);
    expect(decision.moveRecommended).toBe(false);
    expect(decision.retentionReason).toContain('discarded off-script');
    expect(decision.state.committedTokens.join(' ')).not.toContain('pickup');
  });

  it('keeps noisy Local Whisper chunks from permanently polluting manuscript evidence', () => {
    const model = buildManuscript(SAMPLE_MANUSCRIPT);
    const chunks = [
      'The studio light.',
      'blink once and move mine.',
      'that is permission to be.',
      'again.',
      'See you, Drew.',
      'quiet breath.',
      'Settle to rise on the page and...',
      'red the first sentence.',
      'This is a pickup.',
      'for me.',
      'It does.',
      'it seemed like you are advancing.',
      "You're just sitting there."
    ];
    let state = createAlignmentBufferState();
    let currentTokenIndex = 0;
    const moves: number[] = [];
    const discarded: string[] = [];

    for (const chunk of chunks) {
      const decision = evaluateProvisionalAlignmentBuffer(
        model,
        state,
        transcriptToTokens(chunk),
        currentTokenIndex
      );
      state = decision.state;
      if (decision.moveRecommended) {
        currentTokenIndex = decision.result.tokenIndex;
        moves.push(currentTokenIndex);
      }
      if (!decision.retainedDelta) discarded.push(chunk);
    }

    const evidenceText = alignmentBufferTokens(state).join(' ');
    const firstSentenceTokenIndex = model.tokens.findIndex((token) => token.text === 'sentence');

    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(currentTokenIndex).toBeGreaterThanOrEqual(firstSentenceTokenIndex);
    expect(evidenceText).not.toContain('pickup');
    expect(evidenceText).not.toContain('advancing');
    expect(discarded).toContain('This is a pickup.');
    expect(discarded).toContain("You're just sitting there.");
  });
});
