type ParagraphDraft = {
  text: string;
  charStart: number;
  charEnd: number;
};

type SentenceDraft = {
  text: string;
  charStart: number;
  charEnd: number;
};

function trimDraft(text: string, baseStart: number): ParagraphDraft | null {
  const leading = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = text.match(/\s*$/)?.[0].length ?? 0;
  const trimmed = text.slice(leading, text.length - trailing);
  if (!trimmed) return null;
  return {
    text: trimmed,
    charStart: baseStart + leading,
    charEnd: baseStart + text.length - trailing
  };
}

function protectAbbreviationStops(text: string) {
  return text
    .replace(/\b([ap])\.m\./gi, (_match, hourPrefix: string) => `${hourPrefix}~m~`)
    .replace(/\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr)\./g, (_match, title: string) => `${title}~`);
}

function restoreAbbreviationStops(text: string) {
  return text
    .replace(/\b([ap])~m~/gi, (_match, hourPrefix: string) => `${hourPrefix}.m.`)
    .replace(/\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr)~/g, (_match, title: string) => `${title}.`);
}

export function splitParagraphs(rawText: string) {
  const text = rawText.replace(/\r\n/g, '\n');
  const paragraphs: ParagraphDraft[] = [];
  const separator = /\n\s*\n+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = separator.exec(text)) !== null) {
    const chunk = text.slice(cursor, match.index);
    const draft = trimDraft(chunk, cursor);
    if (draft) paragraphs.push(draft);
    cursor = separator.lastIndex;
  }

  const last = trimDraft(text.slice(cursor), cursor);
  if (last) paragraphs.push(last);
  return paragraphs;
}

export function splitSentences(paragraphText: string, paragraphStart: number) {
  const protectedText = protectAbbreviationStops(paragraphText);
  const sentences: SentenceDraft[] = [];
  const sentencePattern = /[^.!?]+(?:[.!?]+["')\]]*)?|[^.!?]+$/g;
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(protectedText)) !== null) {
    const draft = trimDraft(restoreAbbreviationStops(match[0]), paragraphStart + match.index);
    if (draft) sentences.push(draft);
  }

  if (sentences.length === 0 && paragraphText.trim()) {
    const draft = trimDraft(paragraphText, paragraphStart);
    if (draft) sentences.push(draft);
  }

  return sentences;
}
