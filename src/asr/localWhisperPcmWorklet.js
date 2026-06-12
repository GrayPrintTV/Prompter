class LocalWhisperPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedTarget = options.processorOptions?.targetSamples;
    this.targetSamples = Math.max(1, Math.round(Number(requestedTarget) || sampleRate));
    this.pendingSamples = new Float32Array(this.targetSamples);
    this.pendingLength = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const copyLength = Math.min(
        channel.length - sourceOffset,
        this.targetSamples - this.pendingLength
      );
      this.pendingSamples.set(
        channel.subarray(sourceOffset, sourceOffset + copyLength),
        this.pendingLength
      );
      sourceOffset += copyLength;
      this.pendingLength += copyLength;

      if (this.pendingLength === this.targetSamples) {
        const completedSamples = this.pendingSamples;
        this.port.postMessage(
          { type: 'chunk', samples: completedSamples },
          [completedSamples.buffer]
        );
        this.pendingSamples = new Float32Array(this.targetSamples);
        this.pendingLength = 0;
      }
    }

    return true;
  }
}

registerProcessor('local-whisper-pcm-processor', LocalWhisperPcmProcessor);
