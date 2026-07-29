import { describe, expect, it } from 'vitest';
import { AudioIngress } from '../../electron/server/AudioIngress';

const start = { action: 'start' as const, streamId: 's1', sampleRate: 16000 as const, channels: 1 as const, encoding: 'pcm-s16le' as const, sequenceStart: 0, captureTimestampMs: 1, frameDurationMs: 200 };

describe('AudioIngress', () => {
  it('validates, sequences, and assembles a two-second WAV chunk', async () => {
    const chunks: Buffer[] = [];
    const ingress = new AudioIngress((chunk) => { chunks.push(chunk.wav); }, (id) => id === 'tablet');
    ingress.start('tablet', start);
    for (let sequence = 0; sequence < 10; sequence++) await ingress.accept('tablet', {
      streamId: 's1', sequence, captureTimestampMs: sequence * 200, sampleRate: 16000, channels: 1,
      encoding: 'pcm-s16le', sampleCount: 3200
    }, Buffer.alloc(6400));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].subarray(0, 4).toString()).toBe('RIFF');
    expect(chunks[0].readUInt32LE(24)).toBe(16000);
    expect(ingress.diagnostics().framesReceived).toBe(10);
  });

  it('rejects invalid lengths and counts duplicates and gaps', async () => {
    const ingress = new AudioIngress(() => undefined, () => true);
    ingress.start('tablet', start);
    const metadata = { streamId: 's1', sequence: 0, captureTimestampMs: 1, sampleRate: 16000 as const, channels: 1 as const, encoding: 'pcm-s16le' as const, sampleCount: 3200 };
    await expect(ingress.accept('tablet', metadata, Buffer.alloc(2))).rejects.toThrow('sampleCount');
    await ingress.accept('tablet', metadata, Buffer.alloc(6400));
    await ingress.accept('tablet', metadata, Buffer.alloc(6400));
    await ingress.accept('tablet', { ...metadata, sequence: 3 }, Buffer.alloc(6400));
    expect(ingress.diagnostics()).toMatchObject({ duplicates: 1, gaps: 2, framesDropped: 2 });
  });

  it('enforces the controller lease and bounds buffered audio', async () => {
    expect(() => new AudioIngress(() => undefined, () => false).start('tablet', start)).toThrow('controller lease');
    const ingress = new AudioIngress(() => undefined, () => true, 10_000, 500);
    ingress.start('tablet', start);
    for (let sequence = 0; sequence < 6; sequence++) await ingress.accept('tablet', {
      streamId: 's1', sequence, captureTimestampMs: sequence, sampleRate: 16000, channels: 1,
      encoding: 'pcm-s16le', sampleCount: 3200
    }, Buffer.alloc(6400));
    expect(ingress.diagnostics().queueDurationMs).toBeLessThanOrEqual(600);
    expect(ingress.diagnostics().framesDropped).toBeGreaterThan(0);
  });

  it('associates audio with the authenticated connection and does not let an old close stop its replacement', async () => {
    const ingress = new AudioIngress(() => undefined, () => true);
    const metadata = {
      streamId: 's1', sequence: 0, captureTimestampMs: 1, sampleRate: 16000 as const,
      channels: 1 as const, encoding: 'pcm-s16le' as const, sampleCount: 3200
    };

    ingress.start('tablet', start, 'connection-a');
    expect(ingress.metadataRejectionReason('tablet', metadata, 'connection-b')).toContain('stale connection generation');
    await expect(ingress.accept('tablet', metadata, Buffer.alloc(6400), 'connection-b'))
      .rejects.toThrow('stale connection generation');

    ingress.start('tablet', start, 'connection-b');
    ingress.stop('tablet', 's1', 'connection-a');
    expect(ingress.metadataRejectionReason('tablet', metadata, 'connection-b')).toBeNull();
    await expect(ingress.accept('tablet', metadata, Buffer.alloc(6400), 'connection-b')).resolves.toBeUndefined();
  });

  it('rejects metadata before stream registration and from stale stream ids', () => {
    const ingress = new AudioIngress(() => undefined, () => true);
    const metadata = {
      streamId: 's1', sequence: 0, captureTimestampMs: 1, sampleRate: 16000 as const,
      channels: 1 as const, encoding: 'pcm-s16le' as const, sampleCount: 3200
    };
    expect(ingress.metadataRejectionReason('tablet', metadata, 'connection-a')).toContain('no active audio stream');
    ingress.start('tablet', start, 'connection-a');
    expect(ingress.metadataRejectionReason('tablet', { ...metadata, streamId: 'old-stream' }, 'connection-a'))
      .toContain('stale streamId');
  });
});
