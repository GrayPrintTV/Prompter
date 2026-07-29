import type { LocalWhisperServiceStatus } from '#prompter-shared/domain/types.js';

type WebContentsTarget = {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

type WindowTarget = {
  isDestroyed(): boolean;
  webContents: WebContentsTarget;
};

/**
 * Keeps renderer status delivery separate from the sidecar lifecycle. A sidecar can finish
 * after a BrowserWindow closes; its internal status still changes, but delivery is then a no-op.
 */
export class WhisperStatusPublisher {
  private disposed = false;

  constructor(
    private readonly getWindow: () => WindowTarget | null,
    private readonly getBridge: () => unknown
  ) {}

  publish(status: LocalWhisperServiceStatus) {
    if (this.disposed) return;
    const target = this.getWindow();
    if (!target || target.isDestroyed()) return;
    const contents = target.webContents;
    if (contents.isDestroyed()) return;
    try {
      contents.send('local-whisper:status', { ...status, bridge: this.getBridge() });
    } catch (error) {
      // Native teardown can occur between the checks and send. Do not hide other send failures.
      if (target.isDestroyed() || contents.isDestroyed()) return;
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
  }
}
