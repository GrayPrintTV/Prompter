import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';
import type {
  AsrTranscriptHistoryItem,
  ElectronBridgeDiagnostics,
  LocalWhisperChunkDiagnostics,
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTranscriptResult,
  MicCaptureDiagnostics
} from '../domain/types';

type Listener = (delta: TranscriptDelta) => void;
type StatusListener = (status: LocalWhisperStatus) => void;

type LocalWhisperBridge = {
  ping(): string;
  getBridgeDiagnostics?(): Promise<ElectronBridgeDiagnostics>;
  getLocalWhisperStatus(): Promise<LocalWhisperStatus>;
  startLocalWhisper(settings: LocalWhisperSettings): Promise<LocalWhisperStatus>;
  stopLocalWhisper(): Promise<LocalWhisperStatus>;
  transcribeLocalWhisperChunk(payload: {
    audioData: ArrayBuffer;
    mimeType: string;
    format: string;
    extension: string;
    sampleRate?: number;
    durationSeconds?: number;
    headerSignature?: string;
    settings: LocalWhisperSettings;
  }): Promise<LocalWhisperTranscriptResult>;
  onLocalWhisperStatus(callback: (status: LocalWhisperStatus) => void): () => void;
};

export type LocalWhisperPcmChunk = {
  audioData: ArrayBuffer;
  sampleRate: number;
  durationSeconds: number;
  sequence: number;
};

type PcmChunkRecorder = {
  start(): void | Promise<void>;
  stop(): void;
};

type PcmChunkRecorderOptions = {
  chunkDurationSeconds: number;
  onChunk(chunk: LocalWhisperPcmChunk): void;
  onLog(message: string): void;
  onError(error: Error): void;
};

type LocalWhisperDeps = {
  bridge?: LocalWhisperBridge;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPcmChunkRecorder?: (stream: MediaStream, options: PcmChunkRecorderOptions) => PcmChunkRecorder;
  createAudioContext?: () => AudioContext | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  chunkResponseTimeoutMs?: number;
  now?: () => number;
};

const MAX_MIC_LOG_LINES = 18;
const MAX_TRANSCRIPT_HISTORY = 25;
const DEFAULT_CHUNK_RESPONSE_TIMEOUT_MS = 15000;
const PROVIDER_STATUS_TEXT = new Set([
  'sidecar is running',
  'local whisper sidecar is running',
  'model loading',
  'model loaded',
  'process started',
  'ready'
]);

function isProviderStatusText(text: string) {
  return PROVIDER_STATUS_TEXT.has(text.trim().replace(/\.$/, '').toLowerCase());
}

export function audioHeaderSignature(audioData: ArrayBuffer) {
  const bytes = new Uint8Array(audioData.slice(0, 16));
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const wave = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === 'RIFF' && wave === 'WAVE') return 'RIFF/WAVE';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'WebM';
  }
  return Array.from(bytes.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function encodePcmWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function takeSamples(buffers: Float32Array[], sampleCount: number) {
  const output = new Float32Array(sampleCount);
  let written = 0;
  while (written < sampleCount && buffers.length > 0) {
    const first = buffers[0];
    const needed = sampleCount - written;
    if (first.length <= needed) {
      output.set(first, written);
      written += first.length;
      buffers.shift();
    } else {
      output.set(first.slice(0, needed), written);
      buffers[0] = first.slice(needed);
      written += needed;
    }
  }
  return output;
}

function createDefaultMicDiagnostics(): MicCaptureDiagnostics {
  return {
    captureState: 'not-requested',
    inputLevel: 0,
    deviceLabel: '',
    monitorActive: false,
    errorMessage: null,
    log: []
  };
}

function createDefaultChunkDiagnostics(): LocalWhisperChunkDiagnostics {
  return {
    chunksRecorded: 0,
    chunksQueued: 0,
    chunksSentToMain: 0,
    chunksDropped: 0,
    chunksReceivedBySidecar: 0,
    chunksReturnedFromSidecar: 0,
    chunksEmpty: 0,
    chunksFailed: 0,
    lastChunkBytes: 0,
    lastChunkFormat: '',
    lastMimeType: '',
    lastFileExtension: '',
    lastHeaderSignature: '',
    lastSampleRate: 0,
    lastChunkDurationSeconds: 0,
    lastTranscriptText: '',
    lastSidecarError: null,
    warningMessage: null,
    pendingResponses: 0
  };
}

function createDefaultBridgeDiagnostics(): ElectronBridgeDiagnostics {
  return {
    electronBridgeAvailable: false,
    localWhisperBridgeAvailable: false,
    ipcHandlersRegistered: null,
    errorMessage: 'Bridge has not been checked.',
    prompterApiType: 'undefined',
    pingType: 'undefined',
    pingResult: null,
    appPath: null,
    cwd: null,
    mainDirname: null,
    preloadPath: null,
    preloadExists: null,
    isDev: null,
    viteDevServerUrl: null,
    preloadErrorMessage: null,
    preloadErrorStack: null,
    preloadDiagnosticStarted: null,
    preloadDiagnosticExposed: null,
    preloadDiagnosticErrorMessage: null,
    preloadDiagnosticErrorStack: null
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
  mic: createDefaultMicDiagnostics(),
  chunk: createDefaultChunkDiagnostics(),
  transcriptHistory: [],
  bridge: createDefaultBridgeDiagnostics()
};

export class LocalWhisperAsrProvider implements AsrProvider {
  id = 'local-whisper';
  label = 'Local Whisper';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private mediaStream: MediaStream | null = null;
  private pcmRecorder: PcmChunkRecorder | null = null;
  private statusOff: (() => void) | null = null;
  private busy = false;
  private pendingChunk: any = null;
  private connectionStatus: LocalWhisperStatus = {
    ...DEFAULT_LOCAL_WHISPER_STATUS,
    mic: createDefaultMicDiagnostics(),
    chunk: createDefaultChunkDiagnostics(),
    transcriptHistory: [],
    bridge: createDefaultBridgeDiagnostics()
  };
  private audioContext: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micAnimationFrame: number | null = null;
  private lastLevelUpdateMs = 0;
  private chunkWatchdogTimeout: number | null = null;

  constructor(private settings: LocalWhisperSettings, private deps: LocalWhisperDeps = {}) {
    this.setConnectionStatus({ bridge: this.inspectBridge() });
  }

  setSettings(settings: LocalWhisperSettings) {
    this.settings = settings;
    this.setConnectionStatus({ configured: this.isConfigured() });
  }

  async refreshStatus() {
    const bridgeDiagnostics = await this.refreshBridgeDiagnostics();
    if (!bridgeDiagnostics.localWhisperBridgeAvailable) {
      this.status = 'idle';
      this.setConnectionStatus({
        status: 'idle',
        listening: false,
        sidecarRunning: false,
        modelPhase: 'stopped',
        errorMessage: bridgeDiagnostics.errorMessage,
        bridge: bridgeDiagnostics
      });
      return this.connectionStatus;
    }

    let status: LocalWhisperStatus;
    try {
      status = await this.getBridge().getLocalWhisperStatus();
    } catch (error) {
      const message = this.errorMessage(error, 'Local Whisper IPC status handler is unavailable.');
      const diagnostics: ElectronBridgeDiagnostics = {
        ...bridgeDiagnostics,
        ipcHandlersRegistered: false,
        errorMessage: message
      };
      this.status = 'idle';
      this.setConnectionStatus({
        status: 'idle',
        listening: false,
        sidecarRunning: false,
        modelPhase: 'stopped',
        errorMessage: message,
        bridge: diagnostics
      });
      return this.connectionStatus;
    }
    const remoteStatus = this.sanitizeRemoteStatus(status);
    this.setConnectionStatus({
      ...remoteStatus,
      configured: this.isConfigured(),
      bridge: bridgeDiagnostics,
      mic: {
        ...createDefaultMicDiagnostics(),
        ...remoteStatus.mic,
        ...this.connectionStatus.mic
      },
      chunk: this.mergeChunkDiagnostics(remoteStatus.chunk),
      transcriptHistory: remoteStatus.transcriptHistory?.length
        ? remoteStatus.transcriptHistory
        : this.connectionStatus.transcriptHistory
    });
    return this.connectionStatus;
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;
    const bridgeDiagnostics = await this.refreshBridgeDiagnostics();
    if (!bridgeDiagnostics.localWhisperBridgeAvailable) {
      const message = 'Local Whisper bridge unavailable. Are you running inside Electron?';
      this.status = 'idle';
      this.setConnectionStatus({
        status: 'idle',
        listening: false,
        sidecarRunning: false,
        modelPhase: 'stopped',
        errorMessage: message,
        bridge: { ...bridgeDiagnostics, errorMessage: message }
      });
      this.updateMic({}, message);
      throw new Error(message);
    }

    if (!this.isConfigured()) {
      const message = 'Local Whisper is not configured. Set Python executable and model name.';
      this.setProviderStatus('error', message);
      this.updateMic({ captureState: 'not-requested', errorMessage: message }, 'Setup failed before microphone request.');
      throw new Error(message);
    }

    this.setProviderStatus('starting', null);
    this.updateMic(
      {
        errorMessage: null,
        log: []
      },
      'Start Following requested.'
    );
    this.updateChunk(
      {
        warningMessage: null,
        lastSidecarError: null,
        pendingResponses: 0
      }
    );

    try {
      const bridge = this.getBridge();
      this.statusOff = bridge.onLocalWhisperStatus((status) => {
        const remoteStatus = this.sanitizeRemoteStatus(status);
        this.setConnectionStatus({
          ...remoteStatus,
          configured: this.isConfigured(),
          mic: this.connectionStatus.mic,
          chunk: this.mergeChunkDiagnostics(remoteStatus.chunk),
          transcriptHistory: remoteStatus.transcriptHistory?.length
            ? remoteStatus.transcriptHistory
            : this.connectionStatus.transcriptHistory
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

      const remoteSidecarStatus = this.sanitizeRemoteStatus(sidecarStatus);
      this.setConnectionStatus({
        ...remoteSidecarStatus,
        configured: this.isConfigured(),
        mic: this.connectionStatus.mic,
        chunk: this.mergeChunkDiagnostics(remoteSidecarStatus.chunk),
        transcriptHistory: remoteSidecarStatus.transcriptHistory?.length
          ? remoteSidecarStatus.transcriptHistory
          : this.connectionStatus.transcriptHistory
      });
      this.mediaStream = await this.ensureMicrophoneStream();
      this.pcmRecorder = this.createPcmChunkRecorder(this.mediaStream, {
        chunkDurationSeconds: this.settings.chunkDurationSeconds,
        onChunk: (chunk) => {
          void this.acceptPcmAudioChunk(chunk);
        },
        onLog: (message) => this.updateMic({}, message),
        onError: (error) => {
          const message = this.errorMessage(error, 'PCM capture failed.');
          this.updateMic({ errorMessage: message }, `PCM capture error: ${message}`);
          this.setProviderStatus('error', message);
        }
      });
      await this.pcmRecorder.start();
      this.updateMic({ captureState: 'pcm-capturing' }, 'PCM WAV capture started.');
      this.startChunkWatchdog();
      this.pendingChunk = null;
      this.setProviderStatus('listening', null);
    } catch (error) {
      await this.stop();
      this.setProviderStatus('error', this.errorMessage(error, 'Local Whisper failed to start.'));
      throw error;
    }
  }

  async stop() {
    this.pcmRecorder?.stop();
    this.pcmRecorder = null;
    this.stopChunkWatchdog();
    this.pendingChunk = null;

    if (this.mediaStream && !this.connectionStatus.mic.monitorActive) {
      this.stopStream(this.mediaStream);
      this.mediaStream = null;
      this.stopLevelMeter();
      this.updateMic({ captureState: 'stream-muted-ended', inputLevel: 0 }, 'Microphone stream stopped.');
    } else if (this.mediaStream) {
      this.updateMic({ captureState: 'stream-active' }, 'Following stopped; Mic Monitor remains active.');
    }

    this.statusOff?.();
    this.statusOff = null;
    if (this.inspectBridge().localWhisperBridgeAvailable) {
      await this.getBridge().stopLocalWhisper().catch(() => undefined);
    }
    this.setProviderStatus('stopped', null);
    this.setConnectionStatus({ sidecarRunning: false, modelPhase: 'stopped' });
  }

  async startMicMonitoring() {
    if (this.status === 'starting' || this.status === 'listening') {
      this.updateMic({ monitorActive: true }, 'Mic Monitor attached while following is active.');
      return;
    }

    this.updateMic(
      {
        monitorActive: true,
        errorMessage: null,
        log: []
      },
      'Mic Monitor requested.'
    );

    try {
      this.mediaStream = await this.ensureMicrophoneStream();
    } catch (error) {
      this.mediaStream = null;
      this.updateMic({ monitorActive: false }, 'Mic Monitor failed.');
      throw error;
    }
  }

  async stopMicMonitoring() {
    if (!this.mediaStream && !this.connectionStatus.mic.monitorActive) return;
    if (this.status === 'listening' || this.status === 'starting') {
      this.updateMic({ monitorActive: false }, 'Mic Monitor will release after following stops.');
      return;
    }

    if (this.mediaStream) {
      this.stopStream(this.mediaStream);
      this.mediaStream = null;
      this.stopLevelMeter();
    }
    this.updateMic(
      {
        captureState: 'stream-muted-ended',
        inputLevel: 0,
        monitorActive: false
      },
      'Mic Monitor stopped.'
    );
  }

  async testMicrophone() {
    return this.startMicMonitoring();
  }

  async stopMicTest() {
    return this.stopMicMonitoring();
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
    if (isProviderStatusText(text)) {
      this.updateMic({}, `Ignored provider status text: ${text}`);
      this.updateChunk({ lastTranscriptText: '', warningMessage: null });
      return;
    }
    const displayText = text || '[empty transcript]';
    const historyItem: AsrTranscriptHistoryItem = {
      text,
      displayText,
      isEmpty: text.length === 0,
      isFinal: true,
      timestampMs: this.now(),
      source: 'local-whisper'
    };
    this.setConnectionStatus({
      lastTranscriptDelta: displayText,
      modelPhase: text ? 'ready' : 'returned-empty-transcript',
      transcriptHistory: [...this.connectionStatus.transcriptHistory, historyItem].slice(-MAX_TRANSCRIPT_HISTORY)
    });
    this.updateChunk({ lastTranscriptText: displayText });
    if (!text) {
      this.updateChunk({ chunksEmpty: (this.connectionStatus.chunk.chunksEmpty || 0) + 1 });
      this.updateMic({}, 'Sidecar returned empty transcript.');
      return;
    }
    const delta: TranscriptDelta = {
      text,
      isFinal: true,
      timestampMs: historyItem.timestampMs,
      source: 'local-whisper'
    };
    for (const listener of this.listeners) {
      listener(delta);
    }
  }

  async acceptPcmAudioChunk(chunk: LocalWhisperPcmChunk) {
    return this.acceptEncodedAudioChunk({
      audioData: chunk.audioData,
      mimeType: 'audio/wav',
      format: 'wav',
      extension: 'wav',
      sampleRate: chunk.sampleRate,
      durationSeconds: chunk.durationSeconds,
      headerSignature: audioHeaderSignature(chunk.audioData),
      logLabel: 'PCM WAV'
    });
  }

  async acceptRecordedAudioChunk(blob: Blob) {
    const audioData = await blob.arrayBuffer();
    const headerSignature = audioHeaderSignature(audioData);
    const format = headerSignature === 'RIFF/WAVE' ? 'wav' : headerSignature === 'WebM' ? 'webm' : 'other';
    const extension = format === 'wav' ? 'wav' : format === 'webm' ? 'webm' : 'bin';
    return this.acceptEncodedAudioChunk({
      audioData,
      mimeType: blob.type || (format === 'wav' ? 'audio/wav' : 'application/octet-stream'),
      format,
      extension,
      sampleRate: 0,
      durationSeconds: 0,
      headerSignature,
      logLabel: 'Legacy MediaRecorder'
    });
  }

  private async acceptEncodedAudioChunk(chunk: {
    audioData: ArrayBuffer;
    mimeType: string;
    format: string;
    extension: string;
    sampleRate: number;
    durationSeconds: number;
    headerSignature: string;
    logLabel: string;
  }) {
    const byteLength = chunk.audioData.byteLength;
    this.updateChunk({
      chunksRecorded: this.connectionStatus.chunk.chunksRecorded + 1,
      lastChunkBytes: byteLength,
      lastChunkFormat: chunk.format,
      lastMimeType: chunk.mimeType,
      lastFileExtension: chunk.extension,
      lastHeaderSignature: chunk.headerSignature,
      lastSampleRate: chunk.sampleRate,
      lastChunkDurationSeconds: chunk.durationSeconds,
      warningMessage: null
    });
    if (byteLength > 0) {
      this.updateMic(
        {},
        `${chunk.logLabel} chunk emitted: ${byteLength} bytes, ${chunk.sampleRate || 'unknown'} Hz, ${chunk.durationSeconds.toFixed(2)}s, ${chunk.headerSignature}.`
      );
    }
    if (byteLength === 0) {
      this.updateMic({}, 'Chunk skipped: PCM WAV encoder emitted an empty chunk.');
      return;
    }
    if (this.busy) {
      // Latest-chunk-wins backpressure: drop any previous pending, queue this one as latest.
      // Never fatal, never error status; just diagnostic.
      if (this.pendingChunk) {
        this.updateChunk({ chunksDropped: (this.connectionStatus.chunk.chunksDropped || 0) + 1 });
        this.updateMic({}, 'Chunk dropped (backpressure: keeping latest while in flight).');
      }
      this.pendingChunk = chunk;
      this.updateChunk({ chunksQueued: (this.connectionStatus.chunk.chunksQueued || 0) + 1 });
      this.updateMic({}, 'Chunk queued (latest wins; request already in flight).');
      return;
    }
    if (this.status !== 'listening') {
      this.updateMic({}, `Chunk skipped: provider status is ${this.status}.`);
      return;
    }
    this.busy = true;
    const receivedBefore = this.connectionStatus.chunk.chunksReceivedBySidecar;
    const returnedBefore = this.connectionStatus.chunk.chunksReturnedFromSidecar;
    const timeoutHandle = this.setResponseTimeout();
    try {
      this.updateChunk({
        chunksSentToMain: this.connectionStatus.chunk.chunksSentToMain + 1,
        pendingResponses: this.connectionStatus.chunk.pendingResponses + 1,
        warningMessage: null
      });
      this.setConnectionStatus({ modelPhase: 'transcribing' });
      this.updateMic({ captureState: 'chunk-sent' }, `IPC send to main: ${byteLength} byte ${chunk.format} chunk.`);
      const result = await this.getBridge().transcribeLocalWhisperChunk({
        audioData: chunk.audioData,
        mimeType: chunk.mimeType,
        format: chunk.format,
        extension: chunk.extension,
        sampleRate: chunk.sampleRate,
        durationSeconds: chunk.durationSeconds,
        headerSignature: chunk.headerSignature,
        settings: this.settings
      });
      if (this.connectionStatus.chunk.chunksReceivedBySidecar <= receivedBefore) {
        this.updateChunk({ chunksReceivedBySidecar: receivedBefore + 1 });
      }
      if (this.connectionStatus.chunk.chunksReturnedFromSidecar <= returnedBefore) {
        this.updateChunk({ chunksReturnedFromSidecar: returnedBefore + 1 });
      }
      this.updateChunk({ warningMessage: null, lastSidecarError: null });
      this.updateMic({ captureState: 'chunk-returned' }, 'Sidecar response received.');
      await this.acceptTranscriptResult(result);
    } catch (error) {
      const message = this.errorMessage(error, 'Local Whisper transcription failed.');
      this.updateChunk({ lastSidecarError: message, warningMessage: message, chunksFailed: (this.connectionStatus.chunk.chunksFailed || 0) + 1 });
      this.updateMic({ errorMessage: message }, `Sidecar response failed: ${message}`);
      this.setProviderStatus('error', message);
    } finally {
      this.clearResponseTimeout(timeoutHandle);
      this.updateChunk({ pendingResponses: Math.max(0, this.connectionStatus.chunk.pendingResponses - 1) });
      this.busy = false;
      this.startChunkWatchdog();
      // Drain latest queued (if any) after this response; latest-wins means intermediates were dropped already.
      if (this.pendingChunk) {
        const next = this.pendingChunk;
        this.pendingChunk = null;
        // Defer to avoid deep stack after await; will hit non-busy path and send.
        void Promise.resolve().then(() => this.acceptEncodedAudioChunk(next).catch((e) => {
          this.updateMic({}, `Queued chunk dispatch error: ${this.errorMessage(e, 'unknown')}`);
        }));
      }
    }
  }

  private async ensureMicrophoneStream() {
    if (this.streamIsActive()) {
      this.updateMic({ captureState: 'stream-active' }, 'Reusing active microphone stream.');
      return this.mediaStream as MediaStream;
    }

    this.updateMic({ captureState: 'requesting-permission', errorMessage: null }, 'getUserMedia start.');
    try {
      const stream = await this.getUserMedia({ audio: true });
      const deviceLabel = this.inputDeviceLabel(stream);
      this.mediaStream = stream;
      this.updateMic(
        { captureState: 'permission-granted', deviceLabel, errorMessage: null },
        `getUserMedia success: ${deviceLabel}.`
      );
      this.bindStreamDiagnostics(stream);
      this.startLevelMeter(stream);
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

  private startLevelMeter(stream: MediaStream) {
    this.stopLevelMeter();
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

  private stopLevelMeter() {
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

  private streamIsActive() {
    return Boolean(
      this.mediaStream &&
      this.mediaStream.getAudioTracks().some((track) => track.readyState !== 'ended')
    );
  }

  private startChunkWatchdog() {
    this.stopChunkWatchdog();
    if (this.status !== 'listening' && this.status !== 'starting') return;
    const recordedAtStart = this.connectionStatus.chunk.chunksRecorded;
    const timeoutMs = Math.max(1800, this.settings.chunkDurationSeconds * 1500 + 1000);
    this.chunkWatchdogTimeout = this.requestTimeout(() => {
      const noChunks = this.connectionStatus.chunk.chunksRecorded === recordedAtStart;
      const meterMoving = this.connectionStatus.mic.inputLevel > 0.03;
      if (noChunks && meterMoving && this.status === 'listening') {
        const message = 'Input level is moving, but PCM WAV capture has not emitted chunks.';
        this.updateChunk({ warningMessage: message });
        this.updateMic({}, message);
      }
    }, timeoutMs);
  }

  private stopChunkWatchdog() {
    if (this.chunkWatchdogTimeout !== null) {
      this.cancelTimeout(this.chunkWatchdogTimeout);
      this.chunkWatchdogTimeout = null;
    }
  }

  private setResponseTimeout() {
    return this.requestTimeout(() => {
      const message = `Chunk sent but no sidecar response within ${Math.round(this.responseTimeoutMs / 1000)} seconds.`;
      this.updateChunk({ warningMessage: message });
      this.updateMic({}, message);
    }, this.responseTimeoutMs);
  }

  private clearResponseTimeout(handle: number) {
    this.cancelTimeout(handle);
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

  private updateChunk(patch: Partial<LocalWhisperChunkDiagnostics>) {
    this.setConnectionStatus({
      chunk: {
        ...this.connectionStatus.chunk,
        ...patch
      }
    });
  }

  private mergeChunkDiagnostics(remote?: LocalWhisperChunkDiagnostics) {
    const current = this.connectionStatus.chunk;
    if (!remote) return current;
    return {
      ...current,
      ...remote,
      chunksRecorded: Math.max(current.chunksRecorded, remote.chunksRecorded),
      chunksQueued: Math.max(current.chunksQueued, remote.chunksQueued),
      chunksSentToMain: Math.max(current.chunksSentToMain, remote.chunksSentToMain),
      chunksDropped: Math.max(current.chunksDropped, remote.chunksDropped),
      chunksReceivedBySidecar: Math.max(current.chunksReceivedBySidecar, remote.chunksReceivedBySidecar),
      chunksReturnedFromSidecar: Math.max(current.chunksReturnedFromSidecar, remote.chunksReturnedFromSidecar),
      chunksEmpty: Math.max(current.chunksEmpty, remote.chunksEmpty),
      chunksFailed: Math.max(current.chunksFailed, remote.chunksFailed),
      pendingResponses: Math.max(current.pendingResponses, remote.pendingResponses),
      lastChunkBytes: Math.max(current.lastChunkBytes, remote.lastChunkBytes),
      lastChunkFormat: remote.lastChunkFormat || current.lastChunkFormat,
      lastMimeType: remote.lastMimeType || current.lastMimeType,
      lastFileExtension: remote.lastFileExtension || current.lastFileExtension,
      lastHeaderSignature: remote.lastHeaderSignature || current.lastHeaderSignature,
      lastSampleRate: remote.lastSampleRate || current.lastSampleRate,
      lastChunkDurationSeconds: remote.lastChunkDurationSeconds || current.lastChunkDurationSeconds,
      lastTranscriptText: remote.lastTranscriptText || current.lastTranscriptText
    };
  }

  private inspectBridge(): ElectronBridgeDiagnostics {
    const bridge = (this.deps.bridge ?? this.windowBridge()) as Partial<LocalWhisperBridge> | undefined;
    const preloadDiagnostics = this.readPreloadDiagnostics();
    const mainPreloadError = this.readMainPreloadError();
    const electronBridgeAvailable = Boolean(bridge);
    const prompterApiType = this.deps.bridge
      ? 'object'
      : typeof window === 'undefined'
        ? 'undefined'
        : typeof window.prompterApi;
    const pingType = typeof bridge?.ping;
    let pingResult: string | null = null;
    if (typeof bridge?.ping === 'function') {
      try {
        pingResult = bridge.ping();
      } catch (error) {
        pingResult = `error: ${this.errorMessage(error, 'Ping failed.')}`;
      }
    }
    const localWhisperBridgeAvailable = Boolean(
      pingType === 'function' &&
      typeof bridge?.getLocalWhisperStatus === 'function' &&
      typeof bridge.startLocalWhisper === 'function' &&
      typeof bridge.stopLocalWhisper === 'function' &&
      typeof bridge.transcribeLocalWhisperChunk === 'function' &&
      typeof bridge.onLocalWhisperStatus === 'function'
    );
    const preloadErrorMessage =
      mainPreloadError?.message ?? preloadDiagnostics?.errorMessage ?? null;
    return {
      electronBridgeAvailable,
      localWhisperBridgeAvailable,
      ipcHandlersRegistered: bridge?.getBridgeDiagnostics ? null : localWhisperBridgeAvailable ? null : false,
      prompterApiType,
      pingType,
      pingResult,
      appPath: null,
      cwd: null,
      mainDirname: null,
      preloadPath: mainPreloadError?.preloadPath ?? null,
      preloadExists: null,
      isDev: null,
      viteDevServerUrl: null,
      preloadErrorMessage: mainPreloadError?.message ?? null,
      preloadErrorStack: mainPreloadError?.stack ?? null,
      preloadDiagnosticStarted: preloadDiagnostics?.started ?? null,
      preloadDiagnosticExposed: preloadDiagnostics?.exposed ?? null,
      preloadDiagnosticErrorMessage: preloadDiagnostics?.errorMessage ?? null,
      preloadDiagnosticErrorStack: preloadDiagnostics?.errorStack ?? null,
      errorMessage: localWhisperBridgeAvailable
        ? preloadErrorMessage
        : preloadErrorMessage ?? 'Local Whisper bridge unavailable. Are you running inside Electron?'
    };
  }

  private async refreshBridgeDiagnostics() {
    const localDiagnostics = this.inspectBridge();
    if (!localDiagnostics.localWhisperBridgeAvailable) {
      this.setConnectionStatus({ bridge: localDiagnostics });
      return localDiagnostics;
    }

    const bridge = this.deps.bridge ?? this.windowBridge();
    if (!bridge?.getBridgeDiagnostics) {
      this.setConnectionStatus({ bridge: localDiagnostics });
      return localDiagnostics;
    }

    try {
      const remoteDiagnostics = await bridge.getBridgeDiagnostics();
      const diagnostics: ElectronBridgeDiagnostics = {
        ...localDiagnostics,
        ...remoteDiagnostics,
        electronBridgeAvailable: localDiagnostics.electronBridgeAvailable,
        localWhisperBridgeAvailable: localDiagnostics.localWhisperBridgeAvailable && remoteDiagnostics.localWhisperBridgeAvailable,
        prompterApiType: localDiagnostics.prompterApiType,
        pingType: localDiagnostics.pingType,
        pingResult: localDiagnostics.pingResult,
        preloadErrorMessage: remoteDiagnostics.preloadErrorMessage ?? localDiagnostics.preloadErrorMessage,
        preloadErrorStack: remoteDiagnostics.preloadErrorStack ?? localDiagnostics.preloadErrorStack,
        preloadDiagnosticStarted:
          remoteDiagnostics.preloadDiagnosticStarted ?? localDiagnostics.preloadDiagnosticStarted,
        preloadDiagnosticExposed:
          remoteDiagnostics.preloadDiagnosticExposed ?? localDiagnostics.preloadDiagnosticExposed,
        preloadDiagnosticErrorMessage:
          remoteDiagnostics.preloadDiagnosticErrorMessage ?? localDiagnostics.preloadDiagnosticErrorMessage,
        preloadDiagnosticErrorStack:
          remoteDiagnostics.preloadDiagnosticErrorStack ?? localDiagnostics.preloadDiagnosticErrorStack,
        errorMessage:
          remoteDiagnostics.errorMessage ??
          localDiagnostics.errorMessage ??
          remoteDiagnostics.preloadErrorMessage ??
          remoteDiagnostics.preloadDiagnosticErrorMessage
      };
      this.setConnectionStatus({ bridge: diagnostics });
      return diagnostics;
    } catch (error) {
      const diagnostics: ElectronBridgeDiagnostics = {
        ...localDiagnostics,
        electronBridgeAvailable: localDiagnostics.electronBridgeAvailable,
        localWhisperBridgeAvailable: localDiagnostics.localWhisperBridgeAvailable,
        ipcHandlersRegistered: false,
        errorMessage: this.errorMessage(error, 'Electron IPC bridge diagnostics failed.')
      };
      this.setConnectionStatus({ bridge: diagnostics });
      return diagnostics;
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
    const mic = patch.mic
      ? {
          ...this.connectionStatus.mic,
          ...patch.mic,
          log: patch.mic.log ?? this.connectionStatus.mic.log
        }
      : this.connectionStatus.mic;
    const chunk = patch.chunk
      ? {
          ...this.connectionStatus.chunk,
          ...patch.chunk
        }
      : this.connectionStatus.chunk;
    this.connectionStatus = {
      ...this.connectionStatus,
      ...patch,
      providerId: 'local-whisper',
      configured: this.isConfigured(),
      mic,
      chunk,
      transcriptHistory: patch.transcriptHistory ?? this.connectionStatus.transcriptHistory
    };
    for (const listener of this.statusListeners) {
      listener(this.connectionStatus);
    }
  }

  private sanitizeRemoteStatus(status: LocalWhisperStatus): LocalWhisperStatus {
    const transcriptHistory = status.transcriptHistory.filter((item) => !isProviderStatusText(item.text));
    const lastTranscriptDelta = isProviderStatusText(status.lastTranscriptDelta) ? '' : status.lastTranscriptDelta;
    const lastTranscriptText = isProviderStatusText(status.chunk.lastTranscriptText) ? '' : status.chunk.lastTranscriptText;
    return {
      ...status,
      lastTranscriptDelta,
      transcriptHistory,
      chunk: {
        ...status.chunk,
        lastTranscriptText
      }
    };
  }

  private isConfigured() {
    return Boolean(this.settings.pythonExecutablePath.trim() && this.settings.modelName.trim());
  }

  private getBridge() {
    const bridge = this.deps.bridge ?? this.windowBridge();
    if (
      !bridge?.ping ||
      !bridge.getLocalWhisperStatus ||
      !bridge.startLocalWhisper ||
      !bridge.stopLocalWhisper ||
      !bridge.transcribeLocalWhisperChunk ||
      !bridge.onLocalWhisperStatus
    ) {
      throw new Error('Local Whisper bridge unavailable. Are you running inside Electron?');
    }
    return bridge;
  }

  private windowBridge() {
    return typeof window === 'undefined' ? undefined : window.prompterApi;
  }

  private readPreloadDiagnostics() {
    if (typeof window === 'undefined') return null;
    try {
      return window.prompterPreloadDiagnostics?.getDiagnostics?.() ?? null;
    } catch (error) {
      return {
        started: true,
        exposed: false,
        errorMessage: this.errorMessage(error, 'Unable to read preload diagnostics.'),
        errorStack: error instanceof Error ? error.stack ?? null : null
      };
    }
  }

  private readMainPreloadError() {
    return typeof window === 'undefined' ? null : window.__prompterMainPreloadError ?? null;
  }

  private getUserMedia(constraints: MediaStreamConstraints) {
    const getUserMedia = this.deps.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      throw new Error('Microphone access is unavailable in this renderer.');
    }
    return getUserMedia(constraints);
  }

  private createPcmChunkRecorder(stream: MediaStream, options: PcmChunkRecorderOptions): PcmChunkRecorder {
    if (this.deps.createPcmChunkRecorder) return this.deps.createPcmChunkRecorder(stream, options);

    let audioContext: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let muteNode: GainNode | null = null;
    let stopped = true;
    let sequence = 0;
    let bufferedSamples = 0;
    const buffers: Float32Array[] = [];
    const thisProvider = this;

    const stop = () => {
      stopped = true;
      processorNode?.disconnect();
      sourceNode?.disconnect();
      muteNode?.disconnect();
      processorNode = null;
      sourceNode = null;
      muteNode = null;
      buffers.length = 0;
      bufferedSamples = 0;
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
      options.onLog('PCM WAV capture stopped.');
    };

    return {
      async start() {
        audioContext = thisProvider.createAudioContext();
        if (!audioContext) {
          throw new Error('Web Audio PCM capture is unavailable in this renderer.');
        }

        stopped = false;
        const sampleRate = audioContext.sampleRate;
        const targetSamples = Math.max(1, Math.round(sampleRate * Math.max(1, options.chunkDurationSeconds)));
        sourceNode = audioContext.createMediaStreamSource(stream);
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        muteNode = audioContext.createGain();
        muteNode.gain.value = 0;

        processorNode.onaudioprocess = (event) => {
          if (stopped) return;
          try {
            const input = event.inputBuffer.getChannelData(0);
            const copy = new Float32Array(input);
            buffers.push(copy);
            bufferedSamples += copy.length;

            while (bufferedSamples >= targetSamples) {
              const samples = takeSamples(buffers, targetSamples);
              bufferedSamples -= targetSamples;
              sequence += 1;
              const audioData = encodePcmWav(samples, sampleRate);
              options.onChunk({
                audioData,
                sampleRate,
                durationSeconds: samples.length / sampleRate,
                sequence
              });
            }
          } catch (error) {
            options.onError(error instanceof Error ? error : new Error('PCM capture failed.'));
          }
        };

        sourceNode.connect(processorNode);
        processorNode.connect(muteNode);
        muteNode.connect(audioContext.destination);
        await audioContext.resume();
        options.onLog(`PCM WAV capture armed at ${sampleRate} Hz.`);
      },
      stop
    };
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

  private requestTimeout(callback: () => void, delayMs: number) {
    return window.setTimeout(callback, delayMs);
  }

  private cancelTimeout(handle: number) {
    window.clearTimeout(handle);
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

  private get responseTimeoutMs() {
    return this.deps.chunkResponseTimeoutMs ?? DEFAULT_CHUNK_RESPONSE_TIMEOUT_MS;
  }
}
