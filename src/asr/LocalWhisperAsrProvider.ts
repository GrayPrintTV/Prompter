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
  getBridgeDiagnostics?(): Promise<ElectronBridgeDiagnostics>;
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
  chunkResponseTimeoutMs?: number;
  now?: () => number;
};

const MAX_MIC_LOG_LINES = 18;
const MAX_TRANSCRIPT_HISTORY = 12;
const DEFAULT_CHUNK_RESPONSE_TIMEOUT_MS = 15000;

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
    chunksSentToMain: 0,
    chunksReceivedBySidecar: 0,
    chunksReturnedFromSidecar: 0,
    lastChunkBytes: 0,
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
    errorMessage: 'Bridge has not been checked.'
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
  private recorder: MediaRecorder | null = null;
  private statusOff: (() => void) | null = null;
  private busy = false;
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
  private recorderWatchdogTimeout: number | null = null;

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
    this.setConnectionStatus({
      ...status,
      configured: this.isConfigured(),
      bridge: bridgeDiagnostics,
      mic: {
        ...createDefaultMicDiagnostics(),
        ...status.mic,
        ...this.connectionStatus.mic
      },
      chunk: this.mergeChunkDiagnostics(status.chunk),
      transcriptHistory: status.transcriptHistory?.length
        ? status.transcriptHistory
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
        this.setConnectionStatus({
          ...status,
          configured: this.isConfigured(),
          mic: this.connectionStatus.mic,
          chunk: this.mergeChunkDiagnostics(status.chunk),
          transcriptHistory: status.transcriptHistory?.length
            ? status.transcriptHistory
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

      this.setConnectionStatus({
        ...sidecarStatus,
        configured: this.isConfigured(),
        mic: this.connectionStatus.mic,
        chunk: this.mergeChunkDiagnostics(sidecarStatus.chunk),
        transcriptHistory: sidecarStatus.transcriptHistory?.length
          ? sidecarStatus.transcriptHistory
          : this.connectionStatus.transcriptHistory
      });
      this.mediaStream = await this.ensureMicrophoneStream();
      this.recorder = this.createMediaRecorder(this.mediaStream);
      this.recorder.addEventListener('start', () => {
        this.updateMic({ captureState: 'media-recorder-recording' }, 'MediaRecorder start.');
        this.startRecorderWatchdog();
      });
      this.recorder.addEventListener('stop', () => {
        this.stopRecorderWatchdog();
        this.updateMic(
          { captureState: this.streamIsActive() ? 'stream-active' : 'stream-muted-ended' },
          'MediaRecorder stopped.'
        );
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
      this.setConnectionStatus({ modelPhase: 'ready' });
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
    this.stopRecorderWatchdog();

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

  async acceptRecordedAudioChunk(blob: Blob) {
    this.updateChunk({
      chunksRecorded: this.connectionStatus.chunk.chunksRecorded + 1,
      lastChunkBytes: blob.size,
      warningMessage: null
    });
    if (blob.size > 0) {
      this.updateMic({}, `MediaRecorder chunk emitted: ${blob.size} bytes.`);
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
    const receivedBefore = this.connectionStatus.chunk.chunksReceivedBySidecar;
    const returnedBefore = this.connectionStatus.chunk.chunksReturnedFromSidecar;
    const timeoutHandle = this.setResponseTimeout();
    try {
      const audioData = await blob.arrayBuffer();
      this.updateChunk({
        chunksSentToMain: this.connectionStatus.chunk.chunksSentToMain + 1,
        pendingResponses: this.connectionStatus.chunk.pendingResponses + 1,
        warningMessage: null
      });
      this.setConnectionStatus({ modelPhase: 'transcribing' });
      this.updateMic({ captureState: 'chunk-sent' }, `IPC send to main: ${blob.size} bytes.`);
      const result = await this.getBridge().transcribeLocalWhisperChunk({
        audioData,
        mimeType: blob.type || 'audio/webm',
        settings: this.settings
      });
      if (this.connectionStatus.chunk.chunksReceivedBySidecar <= receivedBefore) {
        this.updateChunk({ chunksReceivedBySidecar: receivedBefore + 1 });
      }
      if (this.connectionStatus.chunk.chunksReturnedFromSidecar <= returnedBefore) {
        this.updateChunk({ chunksReturnedFromSidecar: returnedBefore + 1 });
      }
      this.updateChunk({ warningMessage: null });
      this.updateMic({ captureState: 'chunk-returned' }, 'Sidecar response received.');
      await this.acceptTranscriptResult(result);
    } catch (error) {
      const message = this.errorMessage(error, 'Local Whisper transcription failed.');
      this.updateChunk({ lastSidecarError: message, warningMessage: message });
      this.updateMic({ errorMessage: message }, `Sidecar response failed: ${message}`);
      this.setProviderStatus('error', message);
    } finally {
      this.clearResponseTimeout(timeoutHandle);
      this.updateChunk({ pendingResponses: Math.max(0, this.connectionStatus.chunk.pendingResponses - 1) });
      this.busy = false;
      this.startRecorderWatchdog();
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

  private startRecorderWatchdog() {
    this.stopRecorderWatchdog();
    if (this.status !== 'listening' && this.status !== 'starting') return;
    const recordedAtStart = this.connectionStatus.chunk.chunksRecorded;
    const timeoutMs = Math.max(1800, this.settings.chunkDurationSeconds * 1500 + 1000);
    this.recorderWatchdogTimeout = this.requestTimeout(() => {
      const noChunks = this.connectionStatus.chunk.chunksRecorded === recordedAtStart;
      const meterMoving = this.connectionStatus.mic.inputLevel > 0.03;
      if (noChunks && meterMoving && this.recorder?.state === 'recording') {
        const message = 'Input level is moving, but MediaRecorder has not emitted chunks.';
        this.updateChunk({ warningMessage: message });
        this.updateMic({}, message);
      }
    }, timeoutMs);
  }

  private stopRecorderWatchdog() {
    if (this.recorderWatchdogTimeout !== null) {
      this.cancelTimeout(this.recorderWatchdogTimeout);
      this.recorderWatchdogTimeout = null;
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
      chunksSentToMain: Math.max(current.chunksSentToMain, remote.chunksSentToMain),
      chunksReceivedBySidecar: Math.max(current.chunksReceivedBySidecar, remote.chunksReceivedBySidecar),
      chunksReturnedFromSidecar: Math.max(current.chunksReturnedFromSidecar, remote.chunksReturnedFromSidecar),
      pendingResponses: Math.max(current.pendingResponses, remote.pendingResponses),
      lastChunkBytes: Math.max(current.lastChunkBytes, remote.lastChunkBytes)
    };
  }

  private inspectBridge(): ElectronBridgeDiagnostics {
    const bridge = (this.deps.bridge ?? this.windowBridge()) as Partial<LocalWhisperBridge> | undefined;
    const electronBridgeAvailable = Boolean(bridge);
    const localWhisperBridgeAvailable = Boolean(
      typeof bridge?.getLocalWhisperStatus === 'function' &&
      typeof bridge.startLocalWhisper === 'function' &&
      typeof bridge.stopLocalWhisper === 'function' &&
      typeof bridge.transcribeLocalWhisperChunk === 'function' &&
      typeof bridge.onLocalWhisperStatus === 'function'
    );
    return {
      electronBridgeAvailable,
      localWhisperBridgeAvailable,
      ipcHandlersRegistered: bridge?.getBridgeDiagnostics ? null : localWhisperBridgeAvailable ? null : false,
      errorMessage: localWhisperBridgeAvailable
        ? null
        : 'Local Whisper bridge unavailable. Are you running inside Electron?'
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
      const diagnostics = {
        ...remoteDiagnostics,
        electronBridgeAvailable: true,
        localWhisperBridgeAvailable: localDiagnostics.localWhisperBridgeAvailable && remoteDiagnostics.localWhisperBridgeAvailable,
        errorMessage: remoteDiagnostics.errorMessage
      };
      this.setConnectionStatus({ bridge: diagnostics });
      return diagnostics;
    } catch (error) {
      const diagnostics: ElectronBridgeDiagnostics = {
        electronBridgeAvailable: true,
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

  private isConfigured() {
    return Boolean(this.settings.pythonExecutablePath.trim() && this.settings.modelName.trim());
  }

  private getBridge() {
    const bridge = this.deps.bridge ?? this.windowBridge();
    if (
      !bridge?.getLocalWhisperStatus ||
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
