import { describe, expect, it } from 'vitest';
import { alignTranscript } from '../domain/alignment';
import { buildManuscript } from '../domain/manuscript';

describe('alignment engine', () => {
  it('matches a nearby exact phrase with high confidence', () => {
    const model = buildManuscript('The quick brown fox jumps over the lazy dog. Then it rests.');
    const result = alignTranscript(model, 'quick brown fox jumps', 0);
    expect(result.confidence).toBeGreaterThan(0.76);
    expect(result.sentenceIndex).toBe(0);
    expect(result.tokenIndex).toBeGreaterThanOrEqual(3);
  });

  it('does not advance for off-script speech', () => {
    const model = buildManuscript('The quick brown fox jumps over the lazy dog. Then it rests.');
    const result = alignTranscript(model, 'this is a slate note ignore me completely', 0);
    expect(result.confidence).toBeLessThan(0.54);
    expect(result.tokenIndex).toBe(0);
  });

  it('allows skipped manuscript words without losing the phrase', () => {
    const model = buildManuscript('The quick brown fox jumps over the lazy dog.');
    const result = alignTranscript(model, 'quick fox jumps dog', 0);
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.sentenceIndex).toBe(0);
  });

  it('prefers the repeated phrase nearest the expected position', () => {
    const model = buildManuscript(
      'The room did not answer. That was the bargain. Later, after rain, the room did not answer. That was the bargain.'
    );
    const currentNearSecondPhrase = 12;
    const result = alignTranscript(model, 'the room did not answer that was the bargain', currentNearSecondPhrase);
    expect(result.confidence).toBeGreaterThan(0.76);
    expect(result.tokenIndex).toBeGreaterThan(currentNearSecondPhrase);
  });

  it('can move backward for a recent retake when the phrase is distinctive enough', () => {
    const model = buildManuscript(
      'Mara opened the folder and took a breath. She backed up to the previous sentence and began again. The final paragraph moved forward.'
    );
    const currentAfterFlub = model.tokens.length - 1;
    const result = alignTranscript(model, 'she backed up to the previous sentence and began again', currentAfterFlub);
    expect(result.confidence).toBeGreaterThan(0.76);
    expect(result.tokenIndex).toBeLessThan(currentAfterFlub);
  });

  it('guards against moving on one generic word', () => {
    const model = buildManuscript('The house stood near the road. The road turned near the river.');
    const result = alignTranscript(model, 'the', 0);
    expect(result.confidence).toBeLessThan(0.55);
  });
});
