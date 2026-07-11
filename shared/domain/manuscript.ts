import { normalizeText } from './normalize.js';
import { splitParagraphs, splitSentences } from './segment.js';
import { tokenizeSentence } from './tokenize.js';
import type { ManuscriptModel, ManuscriptParagraph, ManuscriptSentence } from './types.js';

export function buildManuscript(rawText: string): ManuscriptModel {
  const paragraphs: ManuscriptParagraph[] = [];
  const sentences: ManuscriptSentence[] = [];
  const tokens: ManuscriptModel['tokens'] = [];

  for (const paragraphDraft of splitParagraphs(rawText)) {
    const paragraphIndex = paragraphs.length;
    const sentenceStart = sentences.length;

    for (const sentenceDraft of splitSentences(paragraphDraft.text, paragraphDraft.charStart)) {
      const sentenceIndex = sentences.length;
      const tokenStart = tokens.length;
      const sentenceTokens = tokenizeSentence(
        sentenceDraft.text,
        sentenceIndex,
        paragraphIndex,
        sentenceDraft.charStart,
        tokens.length
      );
      tokens.push(...sentenceTokens);
      sentences.push({
        sentenceIndex,
        paragraphIndex,
        text: sentenceDraft.text,
        charStart: sentenceDraft.charStart,
        charEnd: sentenceDraft.charEnd,
        tokenStart,
        tokenEnd: tokens.length
      });
    }

    paragraphs.push({
      paragraphIndex,
      text: paragraphDraft.text,
      charStart: paragraphDraft.charStart,
      charEnd: paragraphDraft.charEnd,
      sentenceStart,
      sentenceEnd: sentences.length
    });
  }

  const tokenFrequency = new Map<string, number>();
  for (const token of tokens) {
    tokenFrequency.set(token.text, (tokenFrequency.get(token.text) ?? 0) + 1);
  }

  return {
    rawText,
    paragraphs,
    sentences,
    tokens,
    tokenFrequency
  };
}

export function clampTokenIndex(model: ManuscriptModel, tokenIndex: number) {
  if (model.tokens.length === 0) return 0;
  return Math.max(0, Math.min(model.tokens.length - 1, tokenIndex));
}

export function findSentenceIndexForToken(model: ManuscriptModel, tokenIndex: number) {
  if (model.sentences.length === 0) return 0;
  const clamped = clampTokenIndex(model, tokenIndex);
  const exact = model.sentences.find(
    (sentence) => clamped >= sentence.tokenStart && clamped < Math.max(sentence.tokenEnd, sentence.tokenStart + 1)
  );
  return exact?.sentenceIndex ?? model.sentences[model.sentences.length - 1].sentenceIndex;
}

export function findParagraphIndexForSentence(model: ManuscriptModel, sentenceIndex: number) {
  return model.sentences[sentenceIndex]?.paragraphIndex ?? 0;
}

export function tokenIndexForSentence(model: ManuscriptModel, sentenceIndex: number) {
  const sentence = model.sentences[Math.max(0, Math.min(model.sentences.length - 1, sentenceIndex))];
  return sentence?.tokenStart ?? 0;
}

export function tokenIndexForParagraph(model: ManuscriptModel, paragraphIndex: number) {
  const paragraph = model.paragraphs[Math.max(0, Math.min(model.paragraphs.length - 1, paragraphIndex))];
  const sentence = paragraph ? model.sentences[paragraph.sentenceStart] : undefined;
  return sentence?.tokenStart ?? 0;
}

export function searchManuscript(model: ManuscriptModel, phrase: string, startTokenIndex = 0) {
  const phraseTokens = normalizeText(phrase).split(' ').filter(Boolean);
  if (phraseTokens.length === 0) return null;

  const starts = [
    Math.max(0, Math.min(startTokenIndex, model.tokens.length - 1)),
    0
  ];

  for (const start of starts) {
    const end = start === 0 ? starts[0] : model.tokens.length - phraseTokens.length + 1;
    for (let i = start; i < end; i += 1) {
      let matched = true;
      for (let j = 0; j < phraseTokens.length; j += 1) {
        if (model.tokens[i + j]?.text !== phraseTokens[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return i;
    }
  }

  return null;
}
