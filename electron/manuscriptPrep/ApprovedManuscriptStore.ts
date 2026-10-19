import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrepApproved } from '#prompter-shared/manuscriptPrep/types.js';

// Only registered, byte-verified approvals may cross the reader/export boundary.
export async function readApproved(projectRoot: string, approvedId: string) {
  if (!/^approved_[a-zA-Z0-9-]{1,100}$/.test(approvedId)) throw new Error('Invalid approval identity.');
  const root = await realpath(projectRoot);
  const project = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
  const approval = (project.approved as PrepApproved[]).find((item) => item.approvedId === approvedId);
  if (!approval) throw new Error('This manuscript has not been approved.');
  const directory = await realpath(path.join(root, 'manuscript-prep', 'approved', approvedId));
  if (!directory.startsWith(root + path.sep)) throw new Error('Approval is outside its project.');
  const textPath = await realpath(path.join(directory, 'manuscript.txt'));
  const provenancePath = await realpath(path.join(directory, 'provenance.json'));
  if (path.dirname(textPath) !== directory || path.dirname(provenancePath) !== directory) throw new Error('Invalid approval artifact path.');
  const bytes = await readFile(textPath);
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== approval.textSha256 || bytes.length !== approval.sizeBytes ||
      hash !== provenance.output?.sha256 || bytes.length !== provenance.output?.sizeBytes) {
    throw new Error('Approved manuscript has changed. Select a verified approval or prepare a new revision.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { approval, text, bytes };
}

export async function exportApproved(projectRoot: string, approvedId: string, destination: string) {
  const verified = await readApproved(projectRoot, approvedId);
  // Create-only: never overwrite source documents, historical approvals or another export.
  await writeFile(destination, verified.bytes, { flag: 'wx' });
  return verified.approval;
}
