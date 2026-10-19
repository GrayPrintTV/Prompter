import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ManuscriptPrepService } from '../../electron/manuscriptPrep/ManuscriptPrepService';
import { readApproved, exportApproved } from '../../electron/manuscriptPrep/ApprovedManuscriptStore';
import { createPdfBuffer } from './fixtures/releasePdf';

const roots: string[] = [];
const services: ManuscriptPrepService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function payload<T>(r: { ok: true; payload: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.payload;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-approval-')); roots.push(root);
  const service = new ManuscriptPrepService({ getUserDataPath: () => root,
    runtimePathContext: () => ({ isPackaged: false, appPath: process.cwd(), mainDirname: process.cwd(), resourcesPath: root }) });
  services.push(service);
  return { root, service, projectId: await service.activeProjectId() };
}

describe('approved manuscript release boundary', () => {
  it('requires PDF review, preserves sources and revisions, restores and exports identical bytes, and rejects tampering', async () => {
    const { root, service, projectId } = await fixture();
    const source = path.join(root, 'chapter.pdf');
    const bytes = createPdfBuffer([{ text: 'Chapter 1', y: 730 }, { text: 'Wait - read this twice.', y: 690 }, { text: 'A final paragraph.', y: 640 }]);
    await writeFile(source, bytes);
    const extracted = payload(await service.extract(projectId, source)) as { draftId: string };
    let draft: any = payload(await service.getDraft(projectId, extracted.draftId));
    expect(draft.blocks.map((b: any) => b.generatedText)).toEqual(['Chapter 1', 'Wait - read this twice.', 'A final paragraph.']);
    expect(await service.approve(projectId, draft.draftId, draft.revision)).toMatchObject({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
    payload(await service.applyReviewChange(projectId, draft.draftId, draft.revision, { operationId: 'op_review', kind: 'resolve_diagnostic', diagnosticId: 'pdf-reading-order', resolution: 'reviewed' }));
    draft = payload(await service.getDraft(projectId, draft.draftId));
    const first = payload(await service.approve(projectId, draft.draftId, draft.revision));
    const projectRoot = path.join(root, 'book-projects', projectId);
    const verified = await readApproved(projectRoot, first.approvedId);
    expect(verified.text).toBe('Chapter 1\n\nWait - read this twice.\n\nA final paragraph.\n');
    const destination = path.join(root, 'proofer-manuscript.txt');
    await exportApproved(projectRoot, first.approvedId, destination);
    expect(await readFile(destination)).toEqual(verified.bytes);
    await expect(exportApproved(projectRoot, first.approvedId, source)).rejects.toThrow();
    payload(await service.applyReviewChange(projectId, draft.draftId, draft.revision, { operationId: 'op_edit', kind: 'replace_block_text', blockId: draft.blocks[1].id, text: 'Deliberately corrected text.' }));
    draft = payload(await service.getDraft(projectId, draft.draftId));
    const second = payload(await service.approve(projectId, draft.draftId, draft.revision));
    expect(second.approvedId).not.toBe(first.approvedId);
    expect((await readApproved(projectRoot, first.approvedId)).bytes).toEqual(verified.bytes);
    await service.dispose();
    expect((await readApproved(projectRoot, second.approvedId)).text).toContain('Deliberately corrected');
    expect(hash(await readFile(source))).toBe(hash(bytes));
    await writeFile(path.join(projectRoot, 'manuscript-prep', 'approved', second.approvedId, 'manuscript.txt'), 'Tampered');
    await expect(readApproved(projectRoot, second.approvedId)).rejects.toThrow('changed');
    await expect(readApproved(projectRoot, '../draft_1')).rejects.toThrow('identity');
    await expect(readApproved(projectRoot, 'approved_unregistered')).rejects.toThrow('not been approved');
  }, 30_000);

  it('refuses a PDF without selectable text before creating a draft', async () => {
    const { root, service, projectId } = await fixture();
    const source = path.join(root, 'scan.pdf'); await writeFile(source, createPdfBuffer([]));
    await expect(service.extract(projectId, source)).rejects.toThrow('no selectable text');
    expect((await service.projectSummary(projectId)).drafts).toHaveLength(0);
  });
});
