import { COMMON_WORDS, transcriptToTokens } from './normalize';
import {
  findParagraphIndexForSentence,
  findSentenceIndexForToken
} from './manuscript';
import type { AlignmentResult, ManuscriptModel } from './types';

type AlignmentOptions = {
  backwardWindow?: number;
  forwardWindow?: number;
  maxTranscriptTokens?: number;
  widenWindow?: boolean;
};

type Candidate = {
  startIndex: number;
  endIndex: number;
  confidence: number;
  matchedTokens: number;
  matchedWeight: number;
  matchedText: string;
  reason: string;
  spanDistance: number;
};

const DEFAULT_BACKWARD_WINDOW = 300;
const DEFAULT_FORWARD_WINDOW = 800;
const DEFAULT_MAX_TRANSCRIPT_TOKENS = 28;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  const current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function tokenQuality(transcriptToken: string, manuscriptToken: string) {
  if (transcriptToken === manuscriptToken) return 1;
  const minLength = Math.min(transcriptToken.length, manuscriptToken.length);
  if (minLength < 5) return 0;

  const distance = levenshtein(transcriptToken, manuscriptToken);
  if (distance <= 1) return 0.86;
  if (minLength >= 7 && distance <= 2) return 0.74;
  return 0;
}

function wordWeight(model: ManuscriptModel, token: string) {
  const frequency = model.tokenFrequency.get(token) ?? 1;
  const total = Math.max(model.tokens.length, 1);
  const idf = 1 + Math.log(1 + total / frequency) / Math.log(1 + total);
  const lengthBonus = token.length >= 9 ? 0.25 : token.length >= 6 ? 0.12 : 0;
  const commonPenalty = COMMON_WORDS.has(token) || token.length <= 2 ? 0.42 : 1;
  return Math.max(0.2, (idf + lengthBonus) * commonPenalty);
}

function candidateScore(
  model: ManuscriptModel,
  fragment: string[],
  startIndex: number,
  currentTokenIndex: number,
  widenWindow: boolean
): Candidate | null {
  const maxLookahead = 5;
  let manuscriptCursor = startIndex;
  let matchedTokens = 0;
  let matchedWeight = 0;
  let gapPenalty = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let consecutive = 0;
  let bestConsecutive = 0;
  const matchedWords: string[] = [];
  const totalWeight = fragment.reduce((sum, token) => sum + wordWeight(model, token), 0);

  for (const fragmentToken of fragment) {
    let bestOffset = -1;
    let bestQuality = 0;

    for (let offset = 0; offset <= maxLookahead; offset += 1) {
      const manuscriptToken = model.tokens[manuscriptCursor + offset];
      if (!manuscriptToken) break;
      const quality = tokenQuality(fragmentToken, manuscriptToken.text);
      if (quality > bestQuality) {
        bestQuality = quality;
        bestOffset = offset;
      }
      if (quality === 1) break;
    }

    if (bestQuality >= 0.72 && bestOffset >= 0) {
      const matchedIndex = manuscriptCursor + bestOffset;
      if (firstMatch === -1) firstMatch = matchedIndex;
      lastMatch = matchedIndex;
      matchedTokens += 1;
      matchedWeight += wordWeight(model, fragmentToken) * bestQuality;
      matchedWords.push(model.tokens[matchedIndex].originalText);

      gapPenalty += Math.max(0, bestOffset - 1) * 0.016;
      consecutive = bestOffset <= 1 ? consecutive + 1 : 1;
      bestConsecutive = Math.max(bestConsecutive, consecutive);
      manuscriptCursor = matchedIndex + 1;
    } else {
      consecutive = 0;
    }
  }

  if (matchedTokens === 0 || lastMatch < 0) return null;

  const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const density = matchedTokens / fragment.length;
  const sequenceBonus = Math.min(bestConsecutive / Math.min(fragment.length, 6), 1) * 0.12;
  const exactPhraseBonus =
    fragment.length >= 3 &&
    model.tokens
      .slice(startIndex, startIndex + fragment.length)
      .every((token, index) => token.text === fragment[index])
      ? 0.12
      : 0;
  const distance = lastMatch - currentTokenIndex;
  const spanDistance =
    currentTokenIndex < firstMatch
      ? firstMatch - currentTokenIndex
      : currentTokenIndex > lastMatch
        ? currentTokenIndex - lastMatch
        : 0;
  const spanProximityBonus =
    spanDistance === 0 ? 0.08 : Math.max(0, 1 - spanDistance / 80) * 0.03;
  const jumpPenalty = widenWindow ? Math.min(Math.abs(distance) / 2600, 0.16) : Math.min(Math.abs(distance) / 1600, 0.14);
  const forwardBonus = distance >= -6 && distance <= 180 ? 0.045 : 0;
  const genericPenalty =
    matchedTokens < 3 || matchedWeight < 1.35 || fragment.every((token) => COMMON_WORDS.has(token))
      ? 0.24
      : 0;
  const shortFragmentPenalty = fragment.length <= 2 ? 0.18 : 0;

  let confidence =
    coverage * 0.7 +
    density * 0.18 +
    sequenceBonus +
    exactPhraseBonus +
    spanProximityBonus +
    forwardBonus -
    jumpPenalty -
    gapPenalty -
    genericPenalty -
    shortFragmentPenalty;

  if (matchedTokens < 2) confidence = Math.min(confidence, 0.36);
  if (matchedTokens < 3 && matchedWords.every((word) => COMMON_WORDS.has(word.toLowerCase()))) {
    confidence = Math.min(confidence, 0.42);
  }

  confidence = clamp(confidence, 0, 0.99);
  const reasonParts = [
    `${matchedTokens}/${fragment.length} words`,
    `coverage ${coverage.toFixed(2)}`,
    spanDistance === 0 ? 'span overlaps expected position' : `span ${spanDistance} words from expected position`,
    distance < -8 ? 'backward candidate' : distance > 120 ? 'forward candidate' : 'near expected position'
  ];

  if (exactPhraseBonus > 0) reasonParts.push('exact phrase bonus');
  if (genericPenalty > 0) reasonParts.push('generic/short guard');

  return {
    startIndex: firstMatch,
    endIndex: lastMatch,
    confidence,
    matchedTokens,
    matchedWeight,
    matchedText: matchedWords.join(' '),
    reason: reasonParts.join('; '),
    spanDistance
  };
}

export function alignTranscript(
  model: ManuscriptModel,
  transcript: string | string[],
  currentTokenIndex: number,
  options: AlignmentOptions = {}
): AlignmentResult {
  const fragment = (Array.isArray(transcript) ? transcript : transcriptToTokens(transcript))
    .slice(-(options.maxTranscriptTokens ?? DEFAULT_MAX_TRANSCRIPT_TOKENS))
    .filter(Boolean);

  const clampedCurrent = clamp(currentTokenIndex, 0, Math.max(model.tokens.length - 1, 0));
  const backwardWindow = options.backwardWindow ?? DEFAULT_BACKWARD_WINDOW;
  const forwardWindow = options.forwardWindow ?? DEFAULT_FORWARD_WINDOW;
  const widenWindow = Boolean(options.widenWindow);
  const fromToken = widenWindow ? 0 : clamp(clampedCurrent - backwardWindow, 0, model.tokens.length);
  const toToken = widenWindow
    ? model.tokens.length
    : clamp(clampedCurrent + forwardWindow, 0, model.tokens.length);

  if (model.tokens.length === 0 || fragment.length === 0) {
    const sentenceIndex = findSentenceIndexForToken(model, clampedCurrent);
    return {
      tokenIndex: clampedCurrent,
      sentenceIndex,
      paragraphIndex: findParagraphIndexForSentence(model, sentenceIndex),
      confidence: 0,
      matchedText: '',
      reason: 'No manuscript tokens or no transcript words to align.',
      searchWindow: { fromToken, toToken }
    };
  }

  let best: Candidate | null = null;

  for (let startIndex = fromToken; startIndex < toToken; startIndex += 1) {
    const candidate = candidateScore(model, fragment, startIndex, clampedCurrent, widenWindow);
    if (!candidate) continue;
    if (
      !best ||
      candidate.confidence > best.confidence + 0.0001 ||
      (Math.abs(candidate.confidence - best.confidence) <= 0.0001 &&
        (candidate.spanDistance < best.spanDistance ||
          (candidate.spanDistance === best.spanDistance &&
            Math.abs(candidate.endIndex - clampedCurrent) < Math.abs(best.endIndex - clampedCurrent))))
    ) {
      best = candidate;
    }
  }

  if (!best) {
    const sentenceIndex = findSentenceIndexForToken(model, clampedCurrent);
    return {
      tokenIndex: clampedCurrent,
      sentenceIndex,
      paragraphIndex: findParagraphIndexForSentence(model, sentenceIndex),
      confidence: 0,
      matchedText: '',
      reason: 'No plausible local match found; holding position.',
      searchWindow: { fromToken, toToken }
    };
  }

  const sentenceIndex = findSentenceIndexForToken(model, best.endIndex);
  const paragraphIndex = findParagraphIndexForSentence(model, sentenceIndex);
  const confidence = fragment.length <= 2 ? Math.min(best.confidence, 0.54) : best.confidence;

  return {
    tokenIndex: best.endIndex,
    sentenceIndex,
    paragraphIndex,
    confidence,
    matchedText: best.matchedText,
    reason: best.reason,
    searchWindow: { fromToken, toToken }
  };
}
