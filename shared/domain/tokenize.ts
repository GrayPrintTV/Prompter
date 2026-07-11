import { normalizeToken } from './normalize.js';
import type { ManuscriptToken } from './types.js';

const TOKEN_PATTERN = /(?:[\p{L}]\.){2,}|[\p{L}\p{N}]+(?:[â€™'\-][\p{L}\p{N}]+)*/gu;

export function tokenizeSentence(
  sentenceText: string,
  sentenceIndex: number,
  paragraphIndex: number,
  sentenceCharStart: number,
  firstTokenIndex: number
) {
  const tokens: ManuscriptToken[] = [];
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(sentenceText)) !== null) {
    const originalText = match[0];
    const normalized = normalizeToken(originalText);
    if (!normalized) continue;
    tokens.push({
      text: normalized,
      originalText,
      tokenIndex: firstTokenIndex + tokens.length,
      paragraphIndex,
      sentenceIndex,
      charStart: sentenceCharStart + match.index,
      charEnd: sentenceCharStart + match.index + originalText.length
    });
  }

  return tokens;
}
