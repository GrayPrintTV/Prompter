import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferedJsonlLog } from '../../electron/diagnostics/BoundedJsonlLog';
import { DiagnosticLogService } from '../../electron/server/DiagnosticLogService';

describe('diagnostic persistence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('batches asynchronously, preserves enqueue order, and flushes on demand', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-buffered-log-'));
    const logPath = path.join(root, 'diagnostics.ndjson');
    const log = new BufferedJsonlLog(logPath, { flushDelayMs: 60_000 });
    log.append({ event: 'first' });
    log.append({ event: 'second' });
    await log.flush();

    expect((await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event))
      .toEqual(['first', 'second']);
  });

  it('bounds queued data and leaves an explicit dropped-record marker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-buffered-log-'));
    const logPath = path.join(root, 'diagnostics.ndjson');
    const log = new BufferedJsonlLog(logPath, { maxBufferBytes: 150, flushDelayMs: 60_000 });
    expect(log.append({ event: 'kept' })).toBe(true);
    expect(log.append({ event: 'too-large', payload: 'x'.repeat(200) })).toBe(false);
    await log.flush();

    const events = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'kept' }),
      expect.objectContaining({ event: 'diagnostic-records-dropped', count: 1 })
    ]));
  });

  it('coalesces only unchanged usb.connected chatter and preserves a transition before reconnect', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-tablet-log-'));
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const diagnostics = new DiagnosticLogService(root);
    const connected = { component: 'server.usb' as const, level: 'info' as const, event: 'usb.connected', message: 'Tablet authenticated through USB.', details: { selectedSerial: 'tablet-1' } };
    diagnostics.record(connected);
    now += 10_000;
    diagnostics.record(connected);
    now += 1_000;
    diagnostics.record({ ...connected, event: 'usb.awaiting-tablet', message: 'Waiting for tablet authentication.' });
    now += 1_000;
    diagnostics.record(connected);
    await diagnostics.flush();

    const events = (await readFile(path.join(root, 'tablet-server.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event);
    expect(events).toEqual(['usb.connected', 'usb.awaiting-tablet', 'usb.connected']);
  });
});
