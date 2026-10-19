import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PrepApproved, PrepProjectSummary } from '#prompter-shared/manuscriptPrep/types.js';

type ProjectFile = { version: 1; projectId: string; activeApprovedId: string | null; approved: PrepApproved[] };

export class ProjectDataService {
  constructor(private readonly projectsRoot: string) {}

  projectRoot(projectId: string) {
    if (!/^project_[a-zA-Z0-9-]{1,80}$/.test(projectId)) throw new Error('Invalid project ID.');
    return path.join(this.projectsRoot, projectId);
  }

  async activeProjectId() {
    await mkdir(this.projectsRoot, { recursive: true });
    const pointer = path.join(this.projectsRoot, 'active-project.json');
    try {
      const stored = JSON.parse(await readFile(pointer, 'utf8')) as { projectId?: string };
      if (stored.projectId && /^project_[a-zA-Z0-9-]{1,80}$/.test(stored.projectId)) return stored.projectId;
    } catch { /* First use or a legacy install. */ }
    const legacy = path.join(this.projectsRoot, 'project_default');
    const projectId = await existsDirectory(legacy) ? 'project_default' : `project_${randomUUID()}`;
    await this.atomicWrite(pointer, { projectId });
    await this.ensure(projectId);
    return projectId;
  }

  async ensure(projectId: string) {
    const root = this.projectRoot(projectId);
    await mkdir(path.join(root, 'manuscript-prep', 'drafts'), { recursive: true });
    await mkdir(path.join(root, 'manuscript-prep', 'approved'), { recursive: true });
    try { await readFile(path.join(root, 'project.json')); }
    catch { await this.write(root, { version: 1, projectId, activeApprovedId: null, approved: [] }); }
    return root;
  }

  async recordApproved(projectId: string, approval: PrepApproved) {
    const root = await this.ensure(projectId);
    const file = await this.read(root);
    if (!file.approved.some((item) => item.approvedId === approval.approvedId)) file.approved.push(approval);
    await this.write(root, file);
  }

  async summary(projectId: string, drafts: PrepProjectSummary['drafts']): Promise<PrepProjectSummary> {
    const root = await this.ensure(projectId);
    const file = await this.read(root);
    return { projectId, drafts, approved: file.approved };
  }

  async persistIncomplete(projectId: string, draftId: string, displayName = 'Cancelled import') {
    const root = await this.ensure(projectId); const directory = path.join(root, 'manuscript-prep', 'drafts', draftId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, 'draft.json');
    try {
      const existing = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
      await this.atomicWrite(target, { ...existing, state: 'incomplete', incompleteReason: 'cancelled' });
    } catch {
      await this.atomicWrite(target, { draftId, displayName, state: 'incomplete', route: 'direct', revision: 1, source: { displayName, format: 'txt', sha256: '', sizeBytes: 0 }, blocks: [], diagnostics: [{ id: 'cancelled', severity: 'information', category: 'cancelled', message: 'Import cancelled. The source file was not changed.' }], reviewOperations: [], createdAt: new Date().toISOString(), incompleteReason: 'cancelled' });
    }
  }

  private async read(root: string): Promise<ProjectFile> { return JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8')) as ProjectFile; }
  private async write(root: string, value: ProjectFile) { await this.atomicWrite(path.join(root, 'project.json'), value); }
  private async atomicWrite(target: string, value: unknown) { const temporary = `${target}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); await rename(temporary, target); }
}

async function existsDirectory(target: string) { try { return (await (await import('node:fs/promises')).stat(target)).isDirectory(); } catch { return false; } }
