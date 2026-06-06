import { describe, expect, it } from 'vitest';
import { normalizeText, normalizeToken, transcriptToTokens } from '../domain/normalize';
import { buildManuscript } from '../domain/manuscript';

describe('normalization and manuscript indexing', () => {
  it('normalizes quotes, punctuation, apostrophes, case, and whitespace', () => {
    expect(normalizeText("  \"Don't,\" she said -- twice.  ")).toBe('dont she said twice');
    expect(normalizeText('Curly “quotes” and Steve’s line')).toBe('curly quotes and steves line');
    expect(normalizeToken('twenty-six')).toBe('twentysix');
  });

  it('turns transcript fragments into normalized tokens', () => {
    expect(transcriptToTokens('The room did not answer.')).toEqual(['the', 'room', 'did', 'not', 'answer']);
  });

  it('normalizes conservative spoken number and abbreviation forms in transcripts', () => {
    expect(transcriptToTokens('doctor smith checked room two fourteen at six pm')).toEqual([
      'dr',
      'smith',
      'checked',
      'room',
      '214',
      'at',
      '6',
      'pm'
    ]);
    expect(transcriptToTokens('twenty twenty-six')).toEqual(['2026']);
  });

  it('preserves paragraph and sentence indexes while tokenizing', () => {
    const model = buildManuscript('First sentence. Second sentence.\n\nThird paragraph starts here.');
    expect(model.paragraphs).toHaveLength(2);
    expect(model.sentences).toHaveLength(3);
    expect(model.tokens[0]).toMatchObject({ text: 'first', paragraphIndex: 0, sentenceIndex: 0 });
    expect(model.tokens.at(-1)).toMatchObject({ text: 'here', paragraphIndex: 1, sentenceIndex: 2 });
  });

  it('keeps dotted initials together for manuscript matching', () => {
    const model = buildManuscript('Dr. Smith checked Room 214 at 6 p.m.');
    expect(model.tokens.map((token) => token.text)).toContain('pm');
  });
});
