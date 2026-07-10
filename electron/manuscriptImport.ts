import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';

export const NO_SELECTABLE_PDF_TEXT_MESSAGE =
  'No selectable text found in this PDF. Try copy/paste or OCR first.';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export type ImportedManuscriptFormat = 'text' | 'docx' | 'pdf';

export type ImportedManuscriptFile = {
  filePath: string;
  name: string;
  text: string;
  format: ImportedManuscriptFormat;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

type PdfLine = {
  text: string;
  y: number;
  height: number;
};

function normalizeLineEndings(text: string) {
  return text.replace(/\r\n?|\u2028|\u2029/g, '\n').replace(/\u00a0/g, ' ');
}

export function normalizeImportedText(text: string) {
  return normalizeLineEndings(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function appendPdfItem(lineText: string, itemText: string) {
  const next = itemText.trim();
  if (!next) return lineText;
  if (!lineText) return next;
  if (/^[,.;:!?%\)\]\}]/.test(next) || /[\(\[\{\/$-]$/.test(lineText)) {
    return `${lineText}${next}`;
  }
  return `${lineText} ${next}`;
}

export function pdfItemsToLines(items: PdfTextItem[]) {
  const lines: PdfLine[] = [];
  let current: PdfLine | null = null;

  for (const item of items) {
    const text = item.str.trim();
    if (!text) continue;
    const y = Number(item.transform?.[5] ?? 0);
    const height = Math.max(1, Number(item.height) || Math.abs(Number(item.transform?.[3])) || 1);
    const sameLine = current && Math.abs(current.y - y) <= Math.max(2, height * 0.45);

    if (!sameLine) {
      current = { text, y, height };
      lines.push(current);
    } else if (current) {
      current.text = appendPdfItem(current.text, text);
      current.height = Math.max(current.height, height);
    }

    if (item.hasEOL) current = null;
  }

  return lines;
}

export function normalizePdfLines(lines: PdfLine[]) {
  if (lines.length === 0) return '';
  const baselineGaps = lines
    .slice(1)
    .map((line, index) => Math.abs((lines[index]?.y ?? line.y) - line.y))
    .filter((gap) => gap > 1);
  const typicalGap = median(baselineGaps);
  const paragraphs: string[] = [];
  let paragraph = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.text.trim()) continue;
    const previous = index > 0 ? lines[index - 1] : undefined;
    const gap = previous ? Math.abs(previous.y - line.y) : 0;
    const paragraphBreak = Boolean(
      previous &&
      (gap > Math.max(typicalGap * 1.55, previous.height * 1.8) || gap <= 1)
    );

    if (paragraphBreak && paragraph.trim()) {
      paragraphs.push(paragraph.trim());
      paragraph = '';
    }

    const lineText = line.text.trim();
    if (!paragraph) {
      paragraph = lineText;
    } else if (/-$/.test(paragraph) && /^[a-z]/.test(lineText)) {
      paragraph = `${paragraph.slice(0, -1)}${lineText}`;
    } else {
      paragraph = `${paragraph} ${lineText}`;
    }
  }

  if (paragraph.trim()) paragraphs.push(paragraph.trim());
  return normalizeImportedText(paragraphs.join('\n\n'));
}

async function extractDocxText(buffer: Buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeImportedText(result.value);
}

async function extractPdfText(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true
  });
  const document = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items.flatMap((item) =>
        'str' in item && typeof item.str === 'string'
          ? [{
              str: item.str,
              transform: [...item.transform],
              width: item.width,
              height: item.height,
              hasEOL: item.hasEOL
            }]
          : []
      );
      const pageText = normalizePdfLines(pdfItemsToLines(items));
      if (pageText) pages.push(pageText);
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }

  const text = normalizeImportedText(pages.join('\n\n'));
  if (!text) throw new Error(NO_SELECTABLE_PDF_TEXT_MESSAGE);
  return text;
}

export async function importManuscriptFile(filePath: string): Promise<ImportedManuscriptFile> {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.txt', '.md', '.docx', '.pdf'].includes(extension)) {
    throw new Error('Unsupported manuscript file type. Choose TXT, Markdown, DOCX, or PDF.');
  }

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) throw new Error('The selected manuscript path is not a file.');
  if (fileStats.size > MAX_IMPORT_BYTES) {
    throw new Error('The selected manuscript is larger than the 25 MB import limit.');
  }

  const buffer = await readFile(filePath);
  let text: string;
  let format: ImportedManuscriptFormat;

  if (extension === '.docx') {
    text = await extractDocxText(buffer);
    format = 'docx';
  } else if (extension === '.pdf') {
    text = await extractPdfText(buffer);
    format = 'pdf';
  } else {
    text = normalizeImportedText(buffer.toString('utf8'));
    format = 'text';
  }

  if (!text) throw new Error('The selected manuscript file did not contain readable text.');
  return {
    filePath,
    name: path.basename(filePath),
    text,
    format
  };
}
