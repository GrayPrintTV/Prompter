// Platform-neutral manuscript/transcript normalization.
export const COMMON_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your'
]);

const SPOKEN_DIGITS = new Map([
  ['zero', '0'],
  ['oh', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9']
]);

const SPOKEN_TEENS = new Map([
  ['ten', '10'],
  ['eleven', '11'],
  ['twelve', '12'],
  ['thirteen', '13'],
  ['fourteen', '14'],
  ['fifteen', '15'],
  ['sixteen', '16'],
  ['seventeen', '17'],
  ['eighteen', '18'],
  ['nineteen', '19']
]);

const TITLE_ALIASES = new Map([
  ['doctor', 'dr'],
  ['mister', 'mr'],
  ['missus', 'mrs'],
  ['professor', 'prof'],
  ['senior', 'sr'],
  ['junior', 'jr']
]);

export function normalizeText(input: string) {
  return input
    .normalize('NFKC')
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeToken(input: string) {
  return normalizeText(input).replace(/\s+/g, '');
}

export function transcriptToTokens(input: string) {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return normalizeSpokenTokens(normalized.split(' '));
}

export function normalizeSpokenTokens(tokens: string[]) {
  const normalized: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const third = tokens[index + 2];

    if (token === 'p' && next === 'm') {
      normalized.push('pm');
      index += 1;
      continue;
    }

    if (token === 'a' && next === 'm') {
      normalized.push('am');
      index += 1;
      continue;
    }

    if (token === 'twenty' && next === 'twenty' && third && SPOKEN_DIGITS.has(third)) {
      normalized.push(`202${SPOKEN_DIGITS.get(third)}`);
      index += 2;
      continue;
    }

    if (SPOKEN_DIGITS.has(token) && next && SPOKEN_TEENS.has(next)) {
      normalized.push(`${SPOKEN_DIGITS.get(token)}${SPOKEN_TEENS.get(next)}`);
      index += 1;
      continue;
    }

    if (SPOKEN_DIGITS.has(token) && (next === 'am' || next === 'pm')) {
      normalized.push(SPOKEN_DIGITS.get(token) ?? token);
      continue;
    }

    normalized.push(TITLE_ALIASES.get(token) ?? token);
  }

  return normalized;
}
