import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';

type Listener = (delta: TranscriptDelta) => void;

export class MockAsrProvider implements AsrProvider {
  id = 'mock';
  label = 'Mock scripted transcript';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private script: string[] = [];
  private index = 0;
  private intervalMs = 950;
  private doneListeners = new Set<() => void>();

  setScript(lines: string[], intervalMs = 950) {
    this.script = lines;
    this.intervalMs = intervalMs;
    this.index = 0;
  }

  async start() {
    if (this.timer) {
      await this.stop();
    }
    this.status = 'listening';
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status = 'stopped';
  }

  onDelta(callback: Listener) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onDone(callback: () => void) {
    this.doneListeners.add(callback);
    return () => this.doneListeners.delete(callback);
  }

  getStatus() {
    return this.status;
  }

  private emit(text: string) {
    const delta: TranscriptDelta = {
      text,
      isFinal: true,
      timestampMs: Date.now(),
      source: 'mock'
    };
    for (const listener of this.listeners) {
      listener(delta);
    }
  }

  private async tick() {
    if (this.index >= this.script.length) {
      await this.stop();
      for (const listener of this.doneListeners) {
        listener();
      }
      return;
    }

    const line = this.script[this.index] ?? '';
    this.index += 1;
    this.emit(line.replace(/^\[pause\]$/i, ''));
  }
}
