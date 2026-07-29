import { describe, expect, it, vi } from 'vitest';
import { WhisperStatusPublisher } from '../../electron/whisper/WhisperStatusPublisher';

const status = { providerId: 'local-whisper', status: 'stopped' } as any;

describe('WhisperStatusPublisher', () => {
  it('publishes while its target window and webContents are alive', () => {
    const send = vi.fn();
    const publisher = new WhisperStatusPublisher(
      () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }),
      () => ({ ready: true })
    );
    publisher.publish(status);
    expect(send).toHaveBeenCalledWith('local-whisper:status', expect.objectContaining({ providerId: 'local-whisper', bridge: { ready: true } }));
  });

  it('does not throw or send after BrowserWindow or webContents destruction', () => {
    const send = vi.fn();
    let windowDestroyed = false;
    let contentsDestroyed = false;
    const publisher = new WhisperStatusPublisher(
      () => ({ isDestroyed: () => windowDestroyed, webContents: { isDestroyed: () => contentsDestroyed, send } }),
      () => ({})
    );
    windowDestroyed = true;
    expect(() => publisher.publish(status)).not.toThrow();
    windowDestroyed = false; contentsDestroyed = true;
    expect(() => publisher.publish(status)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('treats disposal as idempotent and never publishes afterwards', () => {
    const send = vi.fn();
    const publisher = new WhisperStatusPublisher(
      () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }),
      () => ({})
    );
    publisher.dispose();
    publisher.dispose();
    publisher.publish(status);
    expect(send).not.toHaveBeenCalled();
  });
});
