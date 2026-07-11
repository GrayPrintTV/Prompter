import type { AudioFrameMetadata, AudioStreamStartPayload } from '#prompter-shared/protocol/messages.js';

export type AudioChunk = {
  deviceId: string;
  streamId: string;
  firstSequence: number;
  lastSequence: number;
  sampleRate: 16000 | 48000;
  durationSeconds: number;
  wav: Buffer;
};

export type AudioIngressDiagnostics = {
  framesReceived: number;
  framesDropped: number;
  gaps: number;
  duplicates: number;
  queueDurationMs: number;
  chunksProduced: number;
  lastAudioTimestampMs: number | null;
};

type Stream = {
  deviceId: string;
  start: AudioStreamStartPayload;
  expectedSequence: number;
  frames: Array<{ metadata: AudioFrameMetadata; pcm: Buffer }>;
  sampleCount: number;
};

export class AudioIngress {
  private stream: Stream | null = null;
  private diagnosticsState: AudioIngressDiagnostics = {
    framesReceived: 0, framesDropped: 0, gaps: 0, duplicates: 0,
    queueDurationMs: 0, chunksProduced: 0, lastAudioTimestampMs: null
  };

  constructor(
    private readonly onChunk: (chunk: AudioChunk) => Promise<void> | void,
    private readonly ownsController: (deviceId: string) => boolean,
    private readonly targetChunkMs = 2_000,
    private readonly maxBufferedMs = 6_000
  ) {}

  start(deviceId: string, payload: AudioStreamStartPayload) {
    if (!this.ownsController(deviceId)) throw new Error('Device does not own the controller lease.');
    if (![16000, 48000].includes(payload.sampleRate) || payload.channels !== 1 || payload.encoding !== 'pcm-s16le') {
      throw new Error('Audio must be mono PCM16 little-endian at 16 kHz or 48 kHz.');
    }
    if (payload.frameDurationMs < 100 || payload.frameDurationMs > 250) throw new Error('Audio frames must represent 100-250 ms.');
    this.stream = { deviceId, start: payload, expectedSequence: payload.sequenceStart, frames: [], sampleCount: 0 };
  }

  async accept(deviceId: string, metadata: AudioFrameMetadata, pcm: Buffer) {
    const stream = this.stream;
    if (!stream || stream.deviceId !== deviceId || !this.ownsController(deviceId)) throw new Error('No active audio stream for this controller.');
    if (metadata.streamId !== stream.start.streamId || metadata.sampleRate !== stream.start.sampleRate ||
        metadata.channels !== 1 || metadata.encoding !== 'pcm-s16le') throw new Error('Audio frame metadata does not match the active stream.');
    if (pcm.byteLength !== metadata.sampleCount * 2) {
      this.diagnosticsState.framesDropped++;
      throw new Error('PCM frame length does not match sampleCount.');
    }
    const durationMs = metadata.sampleCount / metadata.sampleRate * 1000;
    if (durationMs < 90 || durationMs > 275) {
      this.diagnosticsState.framesDropped++;
      throw new Error('PCM frame duration is outside the supported range.');
    }
    if (metadata.sequence < stream.expectedSequence) {
      this.diagnosticsState.duplicates++;
      this.diagnosticsState.framesDropped++;
      return;
    }
    if (metadata.sequence > stream.expectedSequence) this.diagnosticsState.gaps += metadata.sequence - stream.expectedSequence;
    stream.expectedSequence = metadata.sequence + 1;
    stream.frames.push({ metadata, pcm: Buffer.from(pcm) });
    stream.sampleCount += metadata.sampleCount;
    this.diagnosticsState.framesReceived++;
    this.diagnosticsState.lastAudioTimestampMs = metadata.captureTimestampMs;
    this.updateQueueDuration();

    while (this.diagnosticsState.queueDurationMs > this.maxBufferedMs && stream.frames.length > 1) {
      const dropped = stream.frames.shift()!;
      stream.sampleCount -= dropped.metadata.sampleCount;
      this.diagnosticsState.framesDropped++;
      this.updateQueueDuration();
    }
    const targetSamples = Math.round(stream.start.sampleRate * this.targetChunkMs / 1000);
    if (stream.sampleCount >= targetSamples) await this.produceChunk(targetSamples);
  }

  stop(deviceId?: string) {
    if (deviceId && this.stream?.deviceId !== deviceId) return;
    this.stream = null;
    this.diagnosticsState.queueDurationMs = 0;
  }

  diagnostics() {
    return { ...this.diagnosticsState };
  }

  private async produceChunk(targetSamples: number) {
    const stream = this.stream!;
    const selected: typeof stream.frames = [];
    let samples = 0;
    while (stream.frames.length && samples < targetSamples) {
      const frame = stream.frames.shift()!;
      selected.push(frame);
      samples += frame.metadata.sampleCount;
      stream.sampleCount -= frame.metadata.sampleCount;
    }
    this.updateQueueDuration();
    const pcm = Buffer.concat(selected.map((frame) => frame.pcm));
    const firstSequence = selected[0].metadata.sequence;
    const lastSequence = selected.at(-1)!.metadata.sequence;
    this.diagnosticsState.chunksProduced++;
    await this.onChunk({
      deviceId: stream.deviceId,
      streamId: stream.start.streamId,
      firstSequence,
      lastSequence,
      sampleRate: stream.start.sampleRate,
      durationSeconds: samples / stream.start.sampleRate,
      wav: AudioIngress.toWav(pcm, stream.start.sampleRate)
    });
  }

  private updateQueueDuration() {
    this.diagnosticsState.queueDurationMs = this.stream ? this.stream.sampleCount / this.stream.start.sampleRate * 1000 : 0;
  }

  static toWav(pcm: Buffer, sampleRate: number) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }
}
