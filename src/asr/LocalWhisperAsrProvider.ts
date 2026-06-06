import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';
import type {
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTranscriptResult,
  MicCaptureDiagnostics
} from '../domain/types';

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
  createAudioContext?: () => AudioContext | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  now?: () => number;
};

const MAX_MIC_LOG_LINES = 18;

function createDefaultMicDiagnostics(): MicCaptureDiagnostics {
  return {
    captureState: 'not-requested',
    inputLevel: 0,
    deviceLabel: '',
    testActive: false,
    lastChunkBytes: 0,
    errorMessage: null,
    log: []
  };
}

export const DEFAULT_LOCAL_WHISPER_STATUS: LocalWhisperStatus = {
  providerId: 'local-whisper',
  configured: true,
  sidecarRunning: false,
  modelPhase: 'stopped',
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null,
  mic: createDefaultMicDiagnostics()
};

export class LocalWhisperAsrProvider implements AsrProvider {
  id = 'local-whisper';
  label = 'Local Whisper';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private mediaStream: MediaStream | null = null;
  private micTestStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private statusOff: (() => void) | null = null;
  private busy = false;
  private connectionStatus: LocalWhisperStatus = {
    ...DEFAULT_LOCAL_WHISPER_STATUS,
    mic: createDefaultMicDiagnostics()
  };
  private audioContext: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micAnimationFrame: number | null = null;
  private lastLevelUpdateMs = 0;

  constructor(private settings: LocalWhisperSettings, private deps: LocalWhisperDeps = {}) {}

  setSettings(settings: LocalWhisperSettings) {
    this.settings = settings;
    this.setConnectionStatus({ configured: this.isConfigured() });
  }

  async refreshStatus() {
    const status = await this.getBridge().getLocalWhisperStatus();
    this.setConnectionStatus({
      ...status,
      configured: this.isConfigured(),
      mic: {
        ...createDefaultMicDiagnostics(),
        ...status.mic,
        ...this.connectionStatus.mic
      }
    });
    return this.connectionStatus;
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;
    if (!this.isConfigured()) {
      const message = 'Local Whisper is not configured. Set Python executable and model name.';
      this.setProviderStatus('error', message);
      this.updateMic({ captureState: 'not-requested', errorMessage: message }, 'Setup failed before microphone request.');
      throw new Error(message);
    }

    await this.stopMicTest();
    this.setProviderStatus('starting', null);
    this.updateMic(
      {
        captureState: 'not-requested',
        inputLevel: 0,
        errorMessage: null,
        log: []
      },
      'Local Whisper start requested.'
    );

    try {
      const bridge = this.getBridge();
      this.statusOff = bridge.onLocalWhisperStatus((status) => {
        this.setConnectionStatus({
          ...status,
          configured: this.isConfigured(),
          mic: this.connectionStatus.mic
        });
      });

      let sidecarStatus: LocalWhisperStatus;
      try {
        sidecarStatus = await bridge.startLocalWhisper(this.settings);
      } catch (error) {
        const message = this.errorMessage(error, 'Local Whisper setup failed.');
        this.updateMic(
          { captureState: 'not-requested', errorMessage: `Setup failed before microphone request: ${message}` },
          `Local Whisper setup failed before getUserMedia: ${message}`
        );
        throw error;
      }

      this.setConnectionStatus({
        ...sidecarStatus,
        configured: this.isConfigured(),
        mic: this.connectionStatus.mic
      });
      this.mediaStream = await this.requestMicrophoneStream();
      this.recorder = this.createMediaRecorder(this.mediaStream);
      this.recorder.addEventListener('start', () => {
        this.updateMic({ captureState: 'media-recorder-recording' }, 'MediaRecorder start.');
      });
      this.recorder.addEventListener('stop', () => {
        this.updateMic({ captureState: 'stream-muted-ended', inputLevel: 0 }, 'MediaRecorder stopped.');
      });
      this.recorder.addEventListener('error', () => {
        this.updateMic(
          { errorMessage: 'MediaRecorder reported an error.' },
          'MediaRecorder error.'
        );
      });
      this.recorder.addEventListener('dataavailable', (event) => {
        void this.acceptRecordedAudioChunk(event.data);
      });
      this.recorder.start(Math.max(1, this.settings.chunkDurationSeconds) * 1000);
      this.updateMic({ captureState: 'media-recorder-recording' }, 'MediaRecorder start requested.');
      this.setProviderStatus('listening', null);
    } catch (error) {
      await this.stop();
      this.setProviderStatus('error', this.errorMessage(error, 'Local Whisper failed to start.'));
      throw error;
    }
  }

  async stop() {
    if (this.recorder?.state !== 'inactive') {
      this.recorder?.stop();
    }
    this.recorder = null;

    if (this.mediaStream) {
      this.stopStream(this.mediaStream);
      this.mediaStream = null;
      this.stopMicMonitor();
      this.updateMic({ captureState: 'stream-muted-ended', inputLevel: 0 }, 'Microphone stream stopped.');
    }

    this.statusOff?.();
    this.statusOff = null;
    await this.getBridge().stopLocalWhisper().catch(() => undefined);
    this.setProviderStatus('stopped', null);
    this.setConnectionStatus({ sidecarRunning: false, modelPhase: 'stopped' });
  }

  async testMicrophone() {
    if (this.status === 'starting' || this.status === 'listening') {
      this.updateMic({}, 'Mic test skipped because Local Whisper is already listening.');
      return;
    }

    await this.stopMicTest();
    this.updateMic(
      {
        captureState: 'not-requested',
        inputLevel: 0,
        testActive: true,
        errorMessage: null,
        log: []
      },
      'Mic test requested.'
    );

    try {
      this.micTestStream = await this.requestMicrophoneStream();
    } catch (error) {
      this.micTestStream = null;
      this.updateMic({ testActive: false }, 'Mic test failed.');
      throw error;
    }
  }

  async stopMicTest() {
    if (!this.micTestStream && !this.connectionStatus.mic.testActive) return;
    if (this.micTestStream) {
      this.stopStream(this.micTestStream);
      this.micTestStream = null;
      this.stopMicMonitor();
    }
    this.updateMic(
      {
        captureState: 'stream-muted-ended',
        inputLevel: 0,
        testActive: false
      },
      'Mic test stopped.'
    );
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

  async acceptRecordedAudioChunk(blob: Blob) {
    if (blob.size > 0) {
      this.updateMic({ lastChunkBytes: blob.size }, `MediaRecorder chunk emitted: ${blob.size} bytes.`);
    }
    if (blob.size === 0) {
      this.updateMic({}, 'Chunk skipped: MediaRecorder emitted an empty blob.');
      return;
    }
    if (this.busy) {
      this.updateMic({}, 'Chunk skipped: transcription request already in flight.');
      return;
    }
    if (this.status !== 'listening') {
      this.updateMic({}, `Chunk skipped: provider status is ${this.status}.`);
      return;
    }
    this.busy = true;
    try {
      const audioData = await blob.arrayBuffer();
      this.updateMic({ captureState: 'chunk-sent' }, `IPC send to main: ${blob.size} bytes.`);
      const result = await this.getBridge().transcribeLocalWhisperChunk({
        audioData,
        mimeType: blob.type || 'audio/webm',
        settings: this.settings
      });
      this.updateMic({ captureState: 'chunk-returned' }, 'Sidecar response received.');
      await this.acceptTranscriptResult(result);
    } catch (error) {
      const message = this.errorMessage(error, 'Local Whisper transcription failed.');
      this.updateMic({ errorMessage: message }, `Sidecar response failed: ${message}`);
      this.setProviderStatus('error', message);
    } finally {
      this.busy = false;
    }
  }

  private async requestMicrophoneStream() {
    this.updateMic({ captureState: 'requesting-permission', errorMessage: null }, 'getUserMedia start.');
    try {
      const stream = await this.getUserMedia({ audio: true });
      const deviceLabel = this.inputDeviceLabel(stream);
      this.updateMic(
        { captureState: 'permission-granted', deviceLabel, errorMessage: null },
        `getUserMedia success: ${deviceLabel}.`
      );
      this.bindStreamDiagnostics(stream);
      this.startMicMonitor(stream);
      this.updateMic({ captureState: 'stream-active' }, 'Microphone stream active.');
      return stream;
    } catch (error) {
      const message = this.errorMessage(error, 'Microphone access failed.');
      const captureState = this.isPermissionDenied(error) ? 'permission-denied' : 'not-requested';
      this.updateMic({ captureState, inputLevel: 0, errorMessage: message }, `getUserMedia failure: ${message}`);
      throw error;
    }
  }

  private bindStreamDiagnostics(stream: MediaStream) {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('mute', () => {
        this.updateMic({ captureState: 'stream-muted-ended', inputLevel: 0 }, 'Microphone stream muted.');
      });
      track.addEventListener('unmute', () => {
        this.updateMic({ captureState: 'stream-active' }, 'Microphone stream active.');
      });
      track.addEventListener('ended', () => {
        this.updateMic({ captureState: 'stream-muted-ended', inputLevel: 0 }, 'Microphone stream ended.');
      });
    }
  }

  private startMicMonitor(stream: MediaStream) {
    this.stopMicMonitor();
    const audioContext = this.createAudioContext();
    if (!audioContext) {
      this.updateMic({}, 'Web Audio analyser unavailable; input level cannot be displayed.');
      return;
    }

    try {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      this.audioContext = audioContext;
      this.micAnalyser = analyser;
      this.micSourceNode = source;
      this.lastLevelUpdateMs = 0;
      const samples = new Uint8Array(analyser.fftSize);

      const updateLevel = () => {
        if (!this.micAnalyser) return;
        this.micAnalyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 3.5);
        if (this.now() - this.lastLevelUpdateMs > 80) {
          this.lastLevelUpdateMs = this.now();
          this.updateMic({ inputLevel: level });
        }
        this.micAnimationFrame = this.requestAnimationFrame(updateLevel);
      };

      void audioContext.resume().catch(() => undefined);
      updateLevel();
    } catch (error) {
      void audioContext.close().catch(() => undefined);
      this.updateMic({}, `Web Audio analyser failed: ${this.errorMessage(error, 'Unable to monitor input level.')}`);
    }
  }

  private stopMicMonitor() {
    if (this.micAnimationFrame !== null) {
      this.cancelAnimationFrame(this.micAnimationFrame);
      this.micAnimationFrame = null;
    }
    this.micSourceNode?.disconnect();
    this.micSourceNode = null;
    this.micAnalyser = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }

  private stopStream(stream: MediaStream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  private inputDeviceLabel(stream: MediaStream) {
    const track = stream.getAudioTracks()[0] ?? stream.getTracks()[0];
    return track?.label || 'Default microphone';
  }

  private updateMic(patch: Partial<MicCaptureDiagnostics>, logMessage?: string) {
    const previous = this.connectionStatus.mic;
    const baseLog = patch.log ?? previous.log;
    const nextLog = logMessage
      ? [...baseLog, logMessage].slice(-MAX_MIC_LOG_LINES)
      : baseLog;
    this.setConnectionStatus({
      mic: {
        ...previous,
        ...patch,
        log: nextLog
      }
    });
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
    const mic = patch.mic
      ? {
          ...this.connectionStatus.mic,
          ...patch.mic,
          log: patch.mic.log ?? this.connectionStatus.mic.log
        }
      : this.connectionStatus.mic;
    this.connectionStatus = {
      ...this.connectionStatus,
      ...patch,
      providerId: 'local-whisper',
      configured: this.isConfigured(),
      mic
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

  private createAudioContext() {
    if (this.deps.createAudioContext) return this.deps.createAudioContext();
    const win = window as typeof window & {
      webkitAudioContext?: new () => AudioContext;
    };
    const AudioContextConstructor = win.AudioContext ?? win.webkitAudioContext;
    return AudioContextConstructor ? new AudioContextConstructor() : null;
  }

  private requestAnimationFrame(callback: FrameRequestCallback) {
    const request = this.deps.requestAnimationFrame ?? window.requestAnimationFrame?.bind(window);
    return request ? request(callback) : window.setTimeout(() => callback(this.now()), 80);
  }

  private cancelAnimationFrame(handle: number) {
    const cancel = this.deps.cancelAnimationFrame ?? window.cancelAnimationFrame?.bind(window);
    if (cancel) {
      cancel(handle);
    } else {
      window.clearTimeout(handle);
    }
  }

  private isPermissionDenied(error: unknown) {
    if (!(error instanceof Error)) return false;
    return /notallowed|permissiondenied|security/i.test(error.name) || /denied|permission/i.test(error.message);
  }

  private errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
