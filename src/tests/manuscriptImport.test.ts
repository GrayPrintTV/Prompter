import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NO_SELECTABLE_PDF_TEXT_MESSAGE,
  importManuscriptFile,
  normalizeImportedText,
  normalizePdfLines
} from '../../electron/manuscriptImport';

const tempDirectories: string[] = [];

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prompter-import-test-'));
  tempDirectories.push(directory);
  return directory;
}

async function createDocxBuffer() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:r><w:t>First audition paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>“Café’s ﬁnal ﬂourish” — wait… use an en–dash.</w:t></w:r></w:p>' +
      '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function createPdfBuffer(lines: Array<{ text: string; y: number }>) {
  const escapePdfText = (text: string) => text.replace(/([\\()])/g, '\\$1');
  const commands = lines
    .map(({ text, y }) => `BT /F1 12 Tf 72 ${y} Td (${escapePdfText(text)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(commands, 'ascii')} >>\nstream\n${commands}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('manuscript import', () => {
  it('normalizes line endings while preserving paragraph breaks', () => {
    expect(normalizeImportedText('First line.\r\n\r\n\r\nSecond line.  ')).toBe(
      'First line.\n\nSecond line.'
    );
  });

  it('preserves narration punctuation and Unicode characters during extraction cleanup', () => {
    const text = '“Café’s ﬁnal ﬂourish” — wait… use an en–dash; don\'t strip it.';
    expect(normalizeImportedText(text)).toBe(text);
    expect(normalizePdfLines([{ text, y: 720, height: 12 }])).toBe(text);
  });

  it('keeps TXT and Markdown import working', async () => {
    const directory = await createTempDirectory();
    const textPath = path.join(directory, 'audition.txt');
    const markdownPath = path.join(directory, 'audition.md');
    await writeFile(textPath, 'First paragraph.\r\n\r\nSecond paragraph.');
    await writeFile(markdownPath, '# Audition\n\nRead this paragraph.');

    expect((await importManuscriptFile(textPath)).text).toBe(
      'First paragraph.\n\nSecond paragraph.'
    );
    expect((await importManuscriptFile(markdownPath)).text).toBe(
      '# Audition\n\nRead this paragraph.'
    );
  });

  it('joins obvious PDF line wraps while preserving larger paragraph gaps', () => {
    expect(
      normalizePdfLines([
        { text: 'First line of a paragraph', y: 720, height: 12 },
        { text: 'continues naturally.', y: 702, height: 12 },
        { text: 'A third wrapped line.', y: 684, height: 12 },
        { text: 'Second paragraph.', y: 630, height: 12 }
      ])
    ).toBe('First line of a paragraph continues naturally. A third wrapped line.\n\nSecond paragraph.');
  });

  it('extracts ordered paragraphs from DOCX', async () => {
    const directory = await createTempDirectory();
    const filePath = path.join(directory, 'audition.docx');
    await writeFile(filePath, await createDocxBuffer());

    const imported = await importManuscriptFile(filePath);

    expect(imported.name).toBe('audition.docx');
    expect(imported.format).toBe('docx');
    expect(imported.text).toBe(
      'First audition paragraph.\n\n“Café’s ﬁnal ﬂourish” — wait… use an en–dash.'
    );
  });

  it('extracts selectable PDF text and rejects image-only PDFs clearly', async () => {
    const directory = await createTempDirectory();
    const readablePath = path.join(directory, 'audition.pdf');
    const emptyPath = path.join(directory, 'scanned.pdf');
    await writeFile(
      readablePath,
      createPdfBuffer([
        { text: 'First audition line', y: 720 },
        { text: 'continues here.', y: 702 },
        { text: 'Still the first paragraph.', y: 684 },
        { text: 'Second paragraph.', y: 630 }
      ])
    );
    await writeFile(emptyPath, createPdfBuffer([]));

    const imported = await importManuscriptFile(readablePath);
    expect(imported.format).toBe('pdf');
    expect(imported.text).toContain('First audition line continues here.');
    await expect(importManuscriptFile(emptyPath)).rejects.toThrow(
      NO_SELECTABLE_PDF_TEXT_MESSAGE
    );
  });
});
