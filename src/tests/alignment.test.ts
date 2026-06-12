import { describe, expect, it } from 'vitest';
import { alignTranscript } from '../domain/alignment';
import { buildManuscript } from '../domain/manuscript';
import { transcriptToTokens } from '../domain/normalize';

function findTokenIndex(model: ReturnType<typeof buildManuscript>, phrase: string, occurrence = 0) {
  const phraseTokens = transcriptToTokens(phrase);
  let seen = 0;

  for (let startIndex = 0; startIndex <= model.tokens.length - phraseTokens.length; startIndex += 1) {
    const matched = phraseTokens.every((token, index) => model.tokens[startIndex + index]?.text === token);
    if (!matched) continue;
    if (seen === occurrence) return startIndex;
    seen += 1;
  }

  throw new Error(`Phrase not found: ${phrase}`);
}

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

  it('retreats to a repeated sentence after a flub instead of jumping to the later duplicate', () => {
    const model = buildManuscript(
      'The room did not answer. That was the bargain. Mara missed the line, cursed softly, and started the sentence again. The room did not answer. That was the bargain.'
    );
    const currentAfterFlub = findTokenIndex(model, 'started the sentence again');
    const result = alignTranscript(model, 'the room did not answer that was the bargain', currentAfterFlub);

    expect(result.confidence).toBeGreaterThanOrEqual(0.76);
    expect(result.tokenIndex).toBeLessThan(currentAfterFlub);
    expect(result.reason).toContain('retake bias applied');
    expect(result.diagnostics?.retakeBiasApplied).toBe(true);
    expect(result.diagnostics?.duplicateJumpPenaltyApplied).toBe(true);
    expect(result.diagnostics?.duplicateJumpCandidateRejected).toBe(true);
  });

  it('keeps a later duplicate when the expected position already overlaps that occurrence', () => {
    const model = buildManuscript(
      'The room did not answer. That was the bargain. Mara took a breath. The room did not answer. That was the bargain.'
    );
    const currentAtSecondOccurrence = findTokenIndex(model, 'the room did not answer', 1);
    const result = alignTranscript(model, 'the room did not answer that was the bargain', currentAtSecondOccurrence);

    expect(result.confidence).toBeGreaterThanOrEqual(0.76);
    expect(result.tokenIndex).toBeGreaterThan(currentAtSecondOccurrence);
    expect(result.diagnostics?.retakeBiasApplied).toBe(false);
    expect(result.diagnostics?.selectedDirection).toBe('overlap');
  });

  it('aligns conservative spoken numbers and abbreviations against manuscript tokens', () => {
    const model = buildManuscript('Dr. Smith checked Room 214 at 6 p.m. The log closed.');
    const result = alignTranscript(model, 'doctor smith checked room two fourteen at six pm', 0);

    expect(result.confidence).toBeGreaterThanOrEqual(0.76);
    expect(result.matchedText).toContain('Room 214');
    expect(result.matchedText).toContain('p.m.');
  });

  it('preserves original manuscript text (punctuation, quotes, semicolons, apostrophes, spacing) via token char offsets for anchoring (render regression)', () => {
    const punctuated = 'Hello, "world"! It\'s fine; yes—really. Death and mayhem, there. Close all doors.';
    const model = buildManuscript(punctuated);
    for (const sent of model.sentences) {
      const sText = sent.text;
      const toks = model.tokens.slice(sent.tokenStart, sent.tokenEnd);
      let recon = '';
      let pos = 0;
      for (const t of toks) {
        const rS = t.charStart - sent.charStart;
        const rE = t.charEnd - sent.charStart;
        if (rS > pos) recon += sText.slice(pos, rS);
        recon += sText.slice(rS, rE);
        pos = rE;
      }
      if (pos < sText.length) recon += sText.slice(pos);
      expect(recon).toBe(sText); // exact original including all punct/spacing; tokens only provide anchor ranges
    }
  });

  it('preserves spaces after sentence-ending punctuation (inter-sentence gaps from paragraph offsets)', () => {
    const input = "Death. And it's not close. This list goes on. My name is Atticus.";
    const model = buildManuscript(input);
    // Simulate the paragraph-offset render logic (gaps between sentence char ranges + sent slices)
    // This must produce the exact original including " . " after periods.
    let fullRecon = '';
    for (const para of model.paragraphs) {
      const pText = para.text;
      const pStart = para.charStart;
      const sents = model.sentences.slice(para.sentenceStart, para.sentenceEnd);
      let pos = 0;
      for (const sent of sents) {
        const relS = sent.charStart - pStart;
        const relE = sent.charEnd - pStart;
        if (relS > pos) fullRecon += pText.slice(pos, relS);
        fullRecon += pText.slice(relS, relE);
        pos = relE;
      }
      if (pos < pText.length) fullRecon += pText.slice(pos);
    }
    expect(fullRecon).toBe(input);
  });
});
