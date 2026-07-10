import { describe, expect, it } from 'vitest';
import { buildManuscript } from '../domain/manuscript';
import { cleanupImportedManuscriptText } from '../domain/manuscriptImportCleanup';

const WITH_SPACING = { addExtraSpacingBetweenLines: true };

describe('manuscript import cleanup', () => {
  it('normalizes line endings and adds one blank line after each existing break', () => {
    expect(cleanupImportedManuscriptText('First line.\r\nSecond line.\rThird line.', WITH_SPACING))
      .toBe('First line.\n\nSecond line.\n\nThird line.');
  });

  it('is idempotent and does not multiply existing blank lines', () => {
    const once = cleanupImportedManuscriptText('First line.\n\n\nSecond line.', WITH_SPACING);
    expect(once).toBe('First line.\n\nSecond line.');
    expect(cleanupImportedManuscriptText(once, WITH_SPACING)).toBe(once);
  });

  it('preserves punctuation, accents, and common ligature characters exactly', () => {
    const text = '“Café’s ﬁnal ﬂourish” — wait… use an en–dash; don\'t strip it.';
    expect(cleanupImportedManuscriptText(text, WITH_SPACING)).toBe(text);
  });

  it('keeps the same normalized token sequence after adding whitespace', () => {
    const source = '“Café’s first line” — wait…\nSecond line uses ﬁne ﬂour.';
    const spaced = cleanupImportedManuscriptText(source, WITH_SPACING);
    expect(buildManuscript(spaced).tokens.map((token) => token.text))
      .toEqual(buildManuscript(source).tokens.map((token) => token.text));
  });

  it('can normalize imported text without adding extra spacing', () => {
    expect(cleanupImportedManuscriptText('First line.\r\nSecond line.', {
      addExtraSpacingBetweenLines: false
    })).toBe('First line.\nSecond line.');
  });
});
