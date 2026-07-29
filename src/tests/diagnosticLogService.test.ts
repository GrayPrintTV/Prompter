import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticLogService } from '../../electron/server/DiagnosticLogService';

describe('DiagnosticLogService', () => {
  it('bounds the live view and redacts secret fields from persisted output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-diagnostics-'));
    const log = new DiagnosticLogService(root, 2, 1024);
    log.record({ component: 'pairing', level: 'info', event: 'pairing.request.received', message: 'request', deviceId: 'device-identifier-long', details: { credential: 'secret', pairingCode: '012345', manuscriptHash: 'abc123safehash', safe: 'visible' } });
    log.record({ component: 'websocket', level: 'warn', event: 'server.websocket.close.received', message: 'closed', closeCode: 1008, closeReason: 'Invalid pairRequest schema' });
    log.record({ component: 'server', level: 'info', event: 'server.listener.started', message: 'ready' });
    expect(log.list()).toHaveLength(2);
    expect(log.format()).toContain('close=1008');
    const persisted = await readFile(log.logPath, 'utf8');
    expect(persisted).not.toContain('012345');
    expect(persisted).not.toContain('secret');
    expect(persisted).toContain('[redacted]');
    expect(persisted).toContain('visible');
    expect(persisted).toContain('abc123safehash');
  });
});
