import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const worker = path.resolve(process.cwd(), 'python', 'manuscript_prep_worker.py');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prompter-prep-')); roots.push(root);
  const projectRoot = path.join(root, 'project_default');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(projectRoot, 'manuscript-prep', 'drafts'), { recursive: true }));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(projectRoot, 'manuscript-prep', 'approved'), { recursive: true }));
  const source = path.join(root, 'source.txt'); return { root, projectRoot, source };
}

async function run(messages: unknown[]) {
  return new Promise<any[]>((resolve, reject) => {
    const child = spawn('python', [worker], { stdio: 'pipe' }); let output = '';
    child.stdout.on('data', (data) => { output += String(data); }); child.on('error', reject);
    child.on('exit', () => resolve(output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))));
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

function sourceRef(source: string, bytes: Buffer) { return { sourceId: 'source_1', canonicalPath: source, displayName: 'source.txt', formatHint: 'txt', expectedSha256: digest(bytes), sizeBytes: bytes.length, archivedCopy: false }; }
function request(requestId: string, operation: string, payload: object) { return { kind: 'request', protocolVersion: 1, requestId, operation, payload }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Manuscript Prep TXT worker', () => {
  it('creates a reviewable TXT draft and atomically approves exact UTF-8 NFC/LF output', async () => {
    const { projectRoot, source } = await fixture(); const bytes = Buffer.from('Cafe\u0301\r\nfirst paragraph\r\n\r\nSecond paragraph\r\n', 'utf8'); await writeFile(source, bytes);
    const ref = sourceRef(source, bytes);
    const replies = await run([
      request('inspect', 'inspect', { projectId: 'project_default', sourceRef: ref }),
      request('extract', 'extract', { projectId: 'project_default', projectRoot, sourceRef: ref, draftId: 'draft_1', idempotencyKey: 'extract_1' }),
      request('get', 'get_draft', { projectId: 'project_default', projectRoot, draftId: 'draft_1' }),
      request('approve', 'approve', { projectId: 'project_default', projectRoot, draftId: 'draft_1', expectedRevision: 1, approvedId: 'approved_1', idempotencyKey: 'approve_1' })
    ]);
    expect(replies[0].kind).toBe('hello'); expect(replies.find((item) => item.requestId === 'inspect').payload.paragraphCount).toBe(2);
    expect(replies.find((item) => item.requestId === 'get').payload.blocks[0].generatedText).toContain('Café');
    const output = await readFile(path.join(projectRoot, 'manuscript-prep', 'approved', 'approved_1', 'manuscript.txt'));
    expect(output.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf])); expect(output.toString('utf8')).toBe('Café\nfirst paragraph\n\nSecond paragraph\n');
    expect(replies.find((item) => item.requestId === 'approve').payload.textSha256).toBe(digest(output));
  });

  it('rejects stale revisions and changed sources without creating an approval package', async () => {
    const { projectRoot, source } = await fixture(); const bytes = Buffer.from('First paragraph.\n\nSecond paragraph.\n'); await writeFile(source, bytes); const ref = sourceRef(source, bytes);
    await run([request('extract', 'extract', { projectId: 'project_default', projectRoot, sourceRef: ref, draftId: 'draft_1', idempotencyKey: 'extract_1' })]);
    const draft = JSON.parse(await readFile(path.join(projectRoot, 'manuscript-prep', 'drafts', 'draft_1', 'draft.json'), 'utf8'));
    const conflict = await run([request('edit', 'apply_review_change', { projectId: 'project_default', projectRoot, draftId: 'draft_1', expectedRevision: 0, idempotencyKey: 'edit_1', operation: { operationId: 'op_1', kind: 'replace_block_text', blockId: draft.blocks[0].id, text: 'No' } })]);
    expect(conflict.find((item) => item.requestId === 'edit').error.code).toBe('DRAFT_REVISION_CONFLICT');
    await writeFile(source, 'Changed source.\n');
    const replies = await run([request('approve', 'approve', { projectId: 'project_default', projectRoot, draftId: 'draft_1', expectedRevision: 1, approvedId: 'approved_1', idempotencyKey: 'approve_1' })]);
    expect(replies.find((item) => item.requestId === 'approve').error.code).toBe('SOURCE_CHANGED');
    await expect(readFile(path.join(projectRoot, 'manuscript-prep', 'approved', 'approved_1', 'manuscript.txt'))).rejects.toThrow();
  }, 20_000);

  it('reports cancellation as a supported protocol operation', async () => {
    const replies = await run([request('cancel', 'cancel', { projectId: 'project_default', targetRequestId: 'request_1' })]);
    expect(replies.find((item) => item.requestId === 'cancel').ok).toBe(true);
  });
});
