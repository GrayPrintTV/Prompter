import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = []; const configuredWorker = process.env.MANUSCRIPT_PREP_WORKER?.trim(); const worker = configuredWorker || path.resolve(process.cwd(), 'python', 'manuscript_prep_worker.py');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (text: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

async function docxBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${ns}"><w:body>${paragraph('CHAPTER ONE', 'Heading1')}${paragraph('First body paragraph.')}${paragraph('Second body paragraph.')}<w:tbl><w:tr><w:tc>${paragraph('Table cell text.')}</w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`);
  zip.file('word/footnotes.xml', `<w:footnotes xmlns:w="${ns}"><w:footnote w:id="1">${paragraph('Footnote text.')}</w:footnote></w:footnotes>`);
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${ns}">${paragraph('RUNNING HEADER')}</w:hdr>`);
  zip.file('word/media/image1.png', 'synthetic media marker');
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function run(messages: unknown[]) { return new Promise<any[]>((resolve, reject) => { const child = configuredWorker ? spawn(worker, [], { stdio: 'pipe' }) : spawn('python', [worker], { stdio: 'pipe' }); let output = ''; child.stdout.on('data', (chunk) => output += String(chunk)); child.on('error', reject); child.on('exit', () => resolve(output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))); child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'); }); }
function request(requestId: string, operation: string, payload: object) { return { kind: 'request', protocolVersion: 1, requestId, operation, payload }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Manuscript Prep DOCX adapter', () => {
  it('preserves Word paragraphs and heading/source metadata, flags structured content, and approves deterministically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prep-docx-')); roots.push(root); const projectRoot = path.join(root, 'project_docx'); const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(projectRoot, 'manuscript-prep', 'drafts'), { recursive: true }); await mkdir(path.join(projectRoot, 'manuscript-prep', 'approved'), { recursive: true });
    const source = path.join(root, 'synthetic-book.docx'); const bytes = await docxBuffer(); await writeFile(source, bytes); const before = hash(bytes);
    const sourceRef = { sourceId: 'source_docx', canonicalPath: source, displayName: 'synthetic-book.docx', formatHint: 'docx', expectedSha256: before, sizeBytes: bytes.length, archivedCopy: false };
    const replies = await run([request('inspect', 'inspect', { projectId: 'project_docx', sourceRef }), request('extract', 'extract', { projectId: 'project_docx', projectRoot, sourceRef, draftId: 'draft_docx', idempotencyKey: 'extract_docx' }), request('draft', 'get_draft', { projectId: 'project_docx', projectRoot, draftId: 'draft_docx' }), request('approve', 'approve', { projectId: 'project_docx', projectRoot, draftId: 'draft_docx', expectedRevision: 1, approvedId: 'approved_docx', idempotencyKey: 'approve_docx' })]);
    expect(replies.find((item) => item.requestId === 'inspect').payload.format).toBe('docx'); const draft = replies.find((item) => item.requestId === 'draft').payload;
    expect(draft.blocks.map((block: any) => block.generatedText)).toEqual(['CHAPTER ONE', 'First body paragraph.', 'Second body paragraph.', 'Table cell text.', 'Footnote text.', 'RUNNING HEADER']);
    expect(draft.blocks[0]).toMatchObject({ type: 'heading', source: { documentOrder: 0, paragraphIndex: 0, story: 'body', styleId: 'Heading1', headingLevel: 1 } });
    expect(draft.blocks[3].source.inTable).toBe(true); expect(draft.diagnostics.map((item: any) => item.category)).toEqual(expect.arrayContaining(['tables', 'notes', 'repeated_headers_footers', 'embedded_content']));
    expect(replies.find((item) => item.requestId === 'approve')).toMatchObject({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
    expect(hash(await readFile(source))).toBe(before);
  }, 20_000);
});
