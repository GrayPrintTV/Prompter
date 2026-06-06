import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';

type Listener = (delta: TranscriptDelta) => void;

export class ManualAsrProvider implements AsrProvider {
  id = 'manual';
  label = 'Manual transcript';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();

  async start() {
    this.status = 'listening';
  }

  async stop() {
    this.status = 'stopped';
  }

  onDelta(callback: Listener) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getStatus() {
    return this.status;
  }

  pushText(text: string, isFinal = true) {
    if (this.status !== 'listening') {
      this.status = 'listening';
    }
    const delta: TranscriptDelta = {
      text,
      isFinal,
      timestampMs: Date.now(),
      source: 'manual'
    };
    for (const listener of this.listeners) {
      listener(delta);
    }
  }
}
