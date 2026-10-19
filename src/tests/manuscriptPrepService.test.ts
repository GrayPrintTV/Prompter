import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManuscriptPrepService } from '../../electron/manuscriptPrep/ManuscriptPrepService';

const roots: string[] = [];
class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); writes: string[] = [];
  stdin = { write: (value: string) => { this.writes.push(value); return true; } };
  kill = vi.fn(() => true);
  send(value: unknown) { this.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')); }
  hello() { this.send({ kind: 'hello', protocolVersion: 1, worker: { name: 'manuscript-prep-worker', version: '0.1.0' } }); }
  requestId() { return JSON.parse(this.writes.at(-1) ?? '{}').requestId as string; }
}
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'prep-service-')); roots.push(root); const file = path.join(root, 'source.txt'); await writeFile(file, 'Safe manuscript text.\n'); return { root, file }; }
async function waitForChild(children: FakeChild[]) { for (let index = 0; index < 20 && !children[0]; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); return children[0]; }
async function waitForRequest(child: FakeChild) { for (let index = 0; index < 20 && child.writes.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('ManuscriptPrepService supervision', () => {
  it('rejects malformed stdout without logging source content or paths', async () => {
    const { root, file } = await fixture(); const children: FakeChild[] = []; const logs: unknown[] = [];
    const service = new ManuscriptPrepService({ runtimePathContext: () => ({ isPackaged: false, appPath: process.cwd(), mainDirname: process.cwd(), resourcesPath: root }), getUserDataPath: () => root, spawnProcess: (() => { const child = new FakeChild(); children.push(child); return child as any; }) as any, appendDiagnosticLog: (entry) => logs.push(entry) });
    const promise = service.inspect('project_test', file); const child = await waitForChild(children); child!.hello(); await waitForRequest(child!); child!.stdout.emit('data', Buffer.from('not-json\n'));
    await expect(promise).resolves.toMatchObject({ ok: false, error: { code: 'WORKER_PROTOCOL_ERROR' } });
    expect(JSON.stringify(logs)).not.toContain('Safe manuscript text'); expect(JSON.stringify(logs)).not.toContain(file);
  });

  it('fences an unexpected exit and successfully restarts for the next request', async () => {
    const { root, file } = await fixture(); const children: FakeChild[] = [];
    const service = new ManuscriptPrepService({ runtimePathContext: () => ({ isPackaged: false, appPath: process.cwd(), mainDirname: process.cwd(), resourcesPath: root }), getUserDataPath: () => root, spawnProcess: (() => { const child = new FakeChild(); children.push(child); return child as any; }) as any });
    const first = service.inspect('project_test', file); const child = await waitForChild(children); child!.hello(); await waitForRequest(child!); child!.emit('exit', 1, null);
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'WORKER_TERMINATED' } });
    const second = service.inspect('project_test', file); for (let index = 0; index < 20 && !children[1]; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); children[1].hello(); await waitForRequest(children[1]); children[1].send({ kind: 'result', protocolVersion: 1, requestId: children[1].requestId(), ok: true, payload: { format: 'txt' } });
    await expect(second).resolves.toEqual({ ok: true, payload: { format: 'txt' } });
  });

  it('terminates a timed-out generation and restarts cleanly', async () => {
    const { root, file } = await fixture(); const children: FakeChild[] = []; const timers: Array<{ callback: () => void; delay: number }> = [];
    const service = new ManuscriptPrepService({ runtimePathContext: () => ({ isPackaged: false, appPath: process.cwd(), mainDirname: process.cwd(), resourcesPath: root }), getUserDataPath: () => root, spawnProcess: (() => { const child = new FakeChild(); children.push(child); return child as any; }) as any, setTimeout: ((callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length as any; }) as any, clearTimeout: (() => undefined) as any });
    const first = service.inspect('project_test', file); const child = await waitForChild(children); child!.hello(); await waitForRequest(child!); timers.find((timer) => timer.delay === 30_000)?.callback();
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'WORKER_TERMINATED' } }); expect(children[0].kill).toHaveBeenCalled();
    const second = service.inspect('project_test', file); for (let index = 0; index < 20 && !children[1]; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); children[1].hello(); await waitForRequest(children[1]); children[1].send({ kind: 'result', protocolVersion: 1, requestId: children[1].requestId(), ok: true, payload: { format: 'txt' } }); await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('persists a cancelled extraction as an ineligible incomplete draft', async () => {
    const { root, file } = await fixture(); const children: FakeChild[] = []; const timers: Array<{ callback: () => void; delay: number }> = [];
    const service = new ManuscriptPrepService({ runtimePathContext: () => ({ isPackaged: false, appPath: process.cwd(), mainDirname: process.cwd(), resourcesPath: root }), getUserDataPath: () => root, spawnProcess: (() => { const child = new FakeChild(); children.push(child); return child as any; }) as any, setTimeout: ((callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length as any; }) as any, clearTimeout: (() => undefined) as any });
    const extraction = service.extract('project_test', file); const child = await waitForChild(children); child!.hello(); await waitForRequest(child!);
    const request = JSON.parse(child!.writes[0]); await service.cancel('project_test', request.requestId); timers.find((timer) => timer.delay === 250)?.callback();
    await expect(extraction).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    const draft = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'book-projects', 'project_test', 'manuscript-prep', 'drafts', request.payload.draftId, 'draft.json'), 'utf8'));
    expect(draft.state).toBe('incomplete'); expect(draft.incompleteReason).toBe('cancelled');
  });
});
