import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = []; const configuredWorker = process.env.MANUSCRIPT_PREP_WORKER?.trim(); const worker = configuredWorker || path.resolve(process.cwd(), 'python', 'manuscript_prep_worker.py');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex'); const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
async function policyDocx() { const zip = new JSZip(); zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'); zip.file('word/document.xml', `<w:document xmlns:w="${ns}"><w:body>${paragraph('Body text.')}<w:tbl><w:tr><w:tc>${paragraph('Table text.')}</w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`); zip.file('word/footnotes.xml', `<w:footnotes xmlns:w="${ns}"><w:footnote w:id="1">${paragraph('Note text.')}</w:footnote></w:footnotes>`); zip.file('word/header1.xml', `<w:hdr xmlns:w="${ns}">${paragraph('REPEATED HEADER')}</w:hdr>`); zip.file('word/header2.xml', `<w:hdr xmlns:w="${ns}">${paragraph('REPEATED HEADER')}</w:hdr>`); zip.file('word/footer1.xml', `<w:ftr xmlns:w="${ns}">${paragraph('SINGLE FOOTER')}</w:ftr>`); return zip.generateAsync({ type: 'nodebuffer' }); }
function request(requestId: string, operation: string, payload: object) { return { kind: 'request', protocolVersion: 1, requestId, operation, payload }; }
async function run(messages: unknown[]) { return new Promise<any[]>((resolve, reject) => { const child = configuredWorker ? spawn(worker, [], { stdio: 'pipe' }) : spawn('python', [worker], { stdio: 'pipe' }); let output = ''; child.stdout.on('data', (chunk) => output += String(chunk)); child.on('error', reject); child.on('exit', () => resolve(output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))); child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'); }); }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Manuscript Prep DOCX review policy', () => {
  it('records reversible material decisions through revisioned operations before deterministic approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prep-docx-policy-')); roots.push(root); const projectRoot = path.join(root, 'project_docx'); await mkdir(path.join(projectRoot, 'manuscript-prep', 'drafts'), { recursive: true }); await mkdir(path.join(projectRoot, 'manuscript-prep', 'approved'), { recursive: true });
    const source = path.join(root, 'policy.docx'); const bytes = await policyDocx(); await writeFile(source, bytes); const sourceRef = { sourceId: 'source_policy', canonicalPath: source, displayName: 'policy.docx', formatHint: 'docx', expectedSha256: hash(bytes), sizeBytes: bytes.length, archivedCopy: false };
    await run([request('extract', 'extract', { projectId: 'project_docx', projectRoot, sourceRef, draftId: 'draft_policy', idempotencyKey: 'extract_policy' })]);
    const initial = (await run([request('draft', 'get_draft', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy' })]))[1].payload;
    const required = initial.diagnostics.filter((item: any) => item.severity === 'review_required'); expect(required).toHaveLength(4); expect(initial.blocks.filter((block: any) => block.source.story !== 'body').every((block: any) => block.included)).toBe(true);
    const table = initial.blocks.find((block: any) => block.source.inTable); const tableDiagnostic = required.find((item: any) => item.blockIds.includes(table.id)); const noteDiagnostic = required.find((item: any) => item.category === 'notes'); const groupDiagnostic = required.find((item: any) => item.groupId); const footerDiagnostic = required.find((item: any) => item.message.includes('footer item'));
    const blocked = (await run([request('blocked', 'approve', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: 1, approvedId: 'approved_policy', idempotencyKey: 'blocked' })]))[1]; expect(blocked).toMatchObject({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
    const exclude = { operationId: 'op_table', kind: 'set_block_inclusion', blockId: table.id, included: false, diagnosticId: tableDiagnostic.id, resolution: 'exclude', reason: 'test' };
    const excluded = (await run([request('exclude', 'apply_review_change', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: 1, idempotencyKey: 'table_exclude', operation: exclude })]))[1]; expect(excluded.payload).toMatchObject({ revision: 2, approvalEligible: false });
    const retry = (await run([request('retry', 'apply_review_change', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: 1, idempotencyKey: 'table_exclude', operation: exclude })]))[1]; expect(retry.payload).toEqual(excluded.payload);
    const stale = (await run([request('stale', 'apply_review_change', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: 1, idempotencyKey: 'stale', operation: exclude })]))[1]; expect(stale).toMatchObject({ ok: false, error: { code: 'DRAFT_REVISION_CONFLICT' } });
    const operations = [
      { operationId: 'op_note', kind: 'resolve_diagnostic', diagnosticId: noteDiagnostic.id, resolution: 'keep_included', reason: 'test' },
      { operationId: 'op_group_exclude', kind: 'apply_repetition_rule', diagnosticId: groupDiagnostic.id, groupId: groupDiagnostic.groupId, included: false, resolution: 'exclude', reason: 'test' },
      { operationId: 'op_group_restore', kind: 'apply_repetition_rule', diagnosticId: groupDiagnostic.id, groupId: groupDiagnostic.groupId, included: true, resolution: 'keep_included', reason: 'test' },
      { operationId: 'op_footer', kind: 'resolve_diagnostic', diagnosticId: footerDiagnostic.id, resolution: 'keep_included', reason: 'test' },
    ];
    let revision = 2; for (const [index, operation] of operations.entries()) { const reply = (await run([request(`op${index}`, 'apply_review_change', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: revision, idempotencyKey: `policy_${index}`, operation })]))[1]; revision = reply.payload.revision; }
    const ready = (await run([request('ready', 'get_draft', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy' })]))[1].payload; expect(ready.revision).toBe(6); expect(ready.blocks.filter((block: any) => block.source.reviewGroup).every((block: any) => block.included)).toBe(true);
    const approval = (await run([request('approve', 'approve', { projectId: 'project_docx', projectRoot, draftId: 'draft_policy', expectedRevision: 6, approvedId: 'approved_policy', idempotencyKey: 'approve_policy' })]))[1]; expect(approval.ok).toBe(true);
    const text = await readFile(path.join(projectRoot, 'manuscript-prep', 'approved', 'approved_policy', 'manuscript.txt')); expect(text.toString('utf8')).toBe('Body text.\n\nNote text.\n\nREPEATED HEADER\n\nREPEATED HEADER\n\nSINGLE FOOTER\n');
    const provenance = JSON.parse(await readFile(path.join(projectRoot, 'manuscript-prep', 'approved', 'approved_policy', 'provenance.json'), 'utf8')); expect(provenance.review.decisions).toMatchObject({ [tableDiagnostic.id]: 'exclude', [noteDiagnostic.id]: 'keep_included', [groupDiagnostic.id]: 'keep_included', [footerDiagnostic.id]: 'keep_included' }); expect(provenance.review.unresolvedNonBlockingWarnings.length).toBeGreaterThan(0); expect(text.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  }, 30_000);
});
