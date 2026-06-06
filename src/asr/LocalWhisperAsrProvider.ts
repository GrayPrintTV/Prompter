import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';
import type { LocalWhisperSettings, LocalWhisperStatus, LocalWhisperTranscriptResult } from '../domain/types';

type Listener = (delta: TranscriptDelta) => void;
type StatusListener = (status: LocalWhisperStatus) => void;

type LocalWhisperBridge = {
  getLocalWhisperStatus(): Promise<LocalWhisperStatus>;
  startLocalWhisper(settings: LocalWhisperSettings): Promise<LocalWhisperStatus>;
  stopLocalWhisper(): Promise<LocalWhisperStatus>;
  transcribeLocalWhisperChunk(payload: {
    audioData: ArrayBuffer;
    mimeType: string;
    settings: LocalWhisperSettings;
  }): Promise<LocalWhisperTranscriptResult>;
  onLocalWhisperStatus(callback: (status: LocalWhisperStatus) => void): () => void;
};

type LocalWhisperDeps = {
  bridge?: LocalWhisperBridge;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMediaRecorder?: (stream: MediaStream) => MediaRecorder;
  now?: () => number;
};

export const DEFAULT_LOCAL_WHISPER_STATUS: LocalWhisperStatus = {
  providerId: 'local-whisper',
  configured: true,
  sidecarRunning: false,
  modelPhase: 'stopped',
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null
};

export class LocalWhisperAsrProvider implements AsrProvider {
  id = 'local-whisper';
  label = 'Local Whisper';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private statusOff: (() => void) | null = null;
  private busy = false;
  private connectionStatus: LocalWhisperStatus = { ...DEFAULT_LOCAL_WHISPER_STATUS };

  constructor(private settings: LocalWhisperSettings, private deps: LocalWhisperDeps = {}) {}

  setSettings(settings: LocalWhisperSettings) {
    this.settings = settings;
    this.setConnectionStatus({ configured: this.isConfigured() });
  }

  async refreshStatus() {
    const status = await this.getBridge().getLocalWhisperStatus();
    this.setConnectionStatus({ ...status, configured: this.isConfigured() });
    return this.connectionStatus;
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;
    if (!this.isConfigured()) {
      const message = 'Local Whisper is not configured. Set Python executable and model name.';
      this.setProviderStatus('error', message);
      throw new Error(message);
    }

    this.setProviderStatus('starting', null);
    try {
      const bridge = this.getBridge();
      this.statusOff = bridge.onLocalWhisperStatus((status) => {
        this.setConnectionStatus({ ...status, configured: this.isConfigured() });
      });
      const sidecarStatus = await bridge.startLocalWhisper(this.settings);
      this.setConnectionStatus({ ...sidecarStatus, configured: this.isConfigured() });
      this.mediaStream = await this.getUserMedia({ audio: true });
      this.recorder = this.createMediaRecorder(this.mediaStream);
      this.recorder.addEventListener('dataavailable', (event) => {
        void this.transcribeBlob(event.data);
      });
      this.recorder.start(Math.max(1, this.settings.chunkDurationSeconds) * 1000);
      this.setProviderStatus('listening', null);
    } catch (error) {
      await this.stop();
      this.setProviderStatus('error', error instanceof Error ? error.message : 'Local Whisper failed to start.');
      throw error;
    }
  }

  async stop() {
    if (this.recorder?.state !== 'inactive') {
      this.recorder?.stop();
    }
    this.recorder = null;

    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = null;

    this.statusOff?.();
    this.statusOff = null;
    await this.getBridge().stopLocalWhisper().catch(() => undefined);
    this.setProviderStatus('stopped', null);
    this.setConnectionStatus({ sidecarRunning: false, modelPhase: 'stopped' });
  }

  onDelta(callback: Listener) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onConnectionStatus(callback: StatusListener) {
    this.statusListeners.add(callback);
    callback(this.connectionStatus);
    return () => this.statusListeners.delete(callback);
  }

  getStatus() {
    return this.status;
  }

  getConnectionStatus() {
    return this.connectionStatus;
  }

  async acceptTranscriptResult(result: LocalWhisperTranscriptResult) {
    const text = result.text.trim();
    if (!text) return;
    const delta: TranscriptDelta = {
      text,
      isFinal: true,
      timestampMs: this.now(),
      source: 'local-whisper'
    };
    this.setConnectionStatus({ lastTranscriptDelta: text });
    for (const listener of this.listeners) {
      listener(delta);
    }
  }

  private async transcribeBlob(blob: Blob) {
    if (this.busy || blob.size === 0 || this.status !== 'listening') return;
    this.busy = true;
    try {
      const result = await this.getBridge().transcribeLocalWhisperChunk({
        audioData: await blob.arrayBuffer(),
        mimeType: blob.type || 'audio/webm',
        settings: this.settings
      });
      await this.acceptTranscriptResult(result);
    } catch (error) {
      this.setProviderStatus('error', error instanceof Error ? error.message : 'Local Whisper transcription failed.');
    } finally {
      this.busy = false;
    }
  }

  private setProviderStatus(status: AsrStatus, errorMessage: string | null) {
    this.status = status;
    this.setConnectionStatus({
      status,
      listening: status === 'listening' || status === 'starting',
      errorMessage
    });
  }

  private setConnectionStatus(patch: Partial<LocalWhisperStatus>) {
    this.connectionStatus = {
      ...this.connectionStatus,
      ...patch,
      providerId: 'local-whisper',
      configured: this.isConfigured()
    };
    for (const listener of this.statusListeners) {
      listener(this.connectionStatus);
    }
  }

  private isConfigured() {
    return Boolean(this.settings.pythonExecutablePath.trim() && this.settings.modelName.trim());
  }

  private getBridge() {
    const bridge = this.deps.bridge ?? window.prompterApi;
    if (
      !bridge?.getLocalWhisperStatus ||
      !bridge.startLocalWhisper ||
      !bridge.stopLocalWhisper ||
      !bridge.transcribeLocalWhisperChunk ||
      !bridge.onLocalWhisperStatus
    ) {
      throw new Error('Local Whisper bridge is unavailable.');
    }
    return bridge;
  }

  private getUserMedia(constraints: MediaStreamConstraints) {
    const getUserMedia = this.deps.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      throw new Error('Microphone access is unavailable in this renderer.');
    }
    return getUserMedia(constraints);
  }

  private createMediaRecorder(stream: MediaStream) {
    if (this.deps.createMediaRecorder) return this.deps.createMediaRecorder(stream);
    return new MediaRecorder(stream, { mimeType: 'audio/webm' });
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
