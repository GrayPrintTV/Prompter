export type TranscriptSource = 'mock' | 'openai-realtime' | 'local' | 'local-whisper' | 'manual';
export type AsrProviderId = 'manual' | 'mock' | 'openai-realtime' | 'local-whisper';

export type TranscriptDelta = {
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestampMs: number;
  source: TranscriptSource;
};

export type AsrTranscriptHistoryItem = TranscriptDelta & {
  displayText: string;
  isEmpty: boolean;
};

export type AsrStatus = 'idle' | 'starting' | 'listening' | 'error' | 'stopped';

export interface AsrProvider {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onDelta(callback: (delta: TranscriptDelta) => void): () => void;
  getStatus(): AsrStatus;
}

export type ManuscriptToken = {
  text: string;
  originalText: string;
  tokenIndex: number;
  paragraphIndex: number;
  sentenceIndex: number;
  charStart: number;
  charEnd: number;
};

export type ManuscriptSentence = {
  sentenceIndex: number;
  paragraphIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenStart: number;
  tokenEnd: number;
};

export type ManuscriptParagraph = {
  paragraphIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  sentenceStart: number;
  sentenceEnd: number;
};

export type ManuscriptModel = {
  rawText: string;
  paragraphs: ManuscriptParagraph[];
  sentences: ManuscriptSentence[];
  tokens: ManuscriptToken[];
  tokenFrequency: Map<string, number>;
};

export type AlignmentResult = {
  tokenIndex: number;
  sentenceIndex: number;
  paragraphIndex: number;
  confidence: number;
  matchedText: string;
  reason: string;
  diagnostics?: {
    retakeBiasApplied: boolean;
    duplicateJumpPenaltyApplied: boolean;
    duplicateJumpCandidateRejected: boolean;
    selectedDirection: 'backward' | 'forward' | 'overlap';
  };
  searchWindow: {
    fromToken: number;
    toToken: number;
  };
};

export type AlignmentBufferDebug = {
  source: TranscriptSource | '';
  rawTranscript: string;
  normalizedTokens: string[];
  retainedTokens: string[];
  rollingBufferTokens: string[];
  provisionalBufferTokens: string[];
  evaluationBufferTokens: string[];
  matchedText: string;
  confidence: number;
  moveDecision: string;
  moveToTokenCalled: boolean;
  retentionDecision: string;
  retentionReason: string;
};

export type FollowState =
  | 'manual'
  | 'paused'
  | 'following'
  | 'holding'
  | 'uncertain'
  | 'lost'
  | 'resyncing'
  | 'retake';

export type DisplaySettings = {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  textWidthCh: number;
  paragraphSpacingEm: number;
  readingZonePercent: number;
  readingZoneHeightLines: number;
  showActiveHighlight: boolean;
  continuousAssistScroll: boolean;
  assistScrollSpeed: number;
  assistCorrectionFeel: number;
  theme: 'dark' | 'light';
  // Default false so Start does not hide controls during tuning/debug (manual Hide + shortcut still work).
  autoHideControlsOnStart?: boolean;
  // Conservative token lookahead for scroll target (confirmed + N). 0 = exact confirmed token (current behavior).
  readingLookaheadTokens?: number;
  addExtraSpacingOnImport: boolean;
};

export type AssistStatusInfo = {
  enabled: boolean;
  state: string; // e.g. 'OFF', 'ON, waiting for confident match', 'cruising', 'stopped: low confidence', 'slowed: Local Whisper lag', ...
  reason?: string;
  cruiseVelocityPxPerSec?: number;
  estimatedPaceLinesPerMin?: number;
};

export type ScrollTestRequest = {
  id: number;
  type: 'lines' | 'reset';
  lineCount?: number;
};

export type ScrollAnimationStatusInfo = {
  reducedMotion: boolean;
  status: string;
  source?: 'live' | 'test';
  reason?: string;
  fromScrollTop?: number;
  targetScrollTop?: number;
  distancePx?: number;
  durationMs?: number;
  easingCurve?: string;
  correctionFeelPercent?: number;
  frameCount?: number;
};

export type LiveAsrConfigStatus = {
  enabled: boolean;
  configured: boolean;
  providerId: 'openai-realtime';
  model: string;
  language: string;
  promptConfigured: boolean;
};

export type OpenAiRealtimeSdpAnswer = {
  answerSdp: string;
  endpointLabel: string;
  model: string;
};

export type LiveAsrConnectionStatus = {
  providerId: 'openai-realtime';
  configured: boolean;
  connected: boolean;
  listening: boolean;
  status: AsrStatus;
  lastTranscriptDelta: string;
  errorMessage: string | null;
};

export type LocalWhisperSettings = {
  pythonExecutablePath: string;
  modelName: string;
  device: string;
  computeType: string;
  chunkDurationSeconds: number;
};

export type MicCaptureState =
  | 'not-requested'
  | 'requesting-permission'
  | 'permission-granted'
  | 'permission-denied'
  | 'stream-active'
  | 'stream-muted-ended'
  | 'media-recorder-recording'
  | 'pcm-capturing'
  | 'chunk-sent'
  | 'chunk-returned';

export type MicCaptureDiagnostics = {
  captureState: MicCaptureState;
  inputLevel: number;
  deviceLabel: string;
  monitorActive: boolean;
  errorMessage: string | null;
  log: string[];
};

export type LocalWhisperSidecarPhase =
  | 'stopped'
  | 'starting'
  | 'process-started'
  | 'model-loading'
  | 'ready'
  | 'transcribing'
  | 'returned-empty-transcript'
  | 'error';

export type LocalWhisperChunkDiagnostics = {
  chunksRecorded: number;
  chunksQueued: number;
  chunksSentToMain: number;
  chunksDropped: number;
  chunksReceivedBySidecar: number;
  chunksReturnedFromSidecar: number;
  chunksEmpty: number;
  chunksFailed: number;
  queueLength: number;
  maxQueueLength: number;
  estimatedQueueLatencyMs: number;
  lastChunkSequence: number;
  processingSequence: number;
  lastTranscriptionDurationMs: number;
  avgTranscriptionDurationMs: number;
  lastRealtimeFactor: number;
  avgRealtimeFactor: number;
  droppedDueToOverflow: number;
  droppedDueToSilence: number;
  staleChunksDropped: number;
  silenceChunksSuppressed: number;
  lastChunkBytes: number;
  lastChunkFormat: string;
  lastMimeType: string;
  lastFileExtension: string;
  lastHeaderSignature: string;
  lastSampleRate: number;
  lastChunkDurationSeconds: number;
  lastTranscriptText: string;
  lastSidecarError: string | null;
  warningMessage: string | null;
  pendingResponses: number;
};

export type ElectronBridgeDiagnostics = {
  electronBridgeAvailable: boolean;
  localWhisperBridgeAvailable: boolean;
  ipcHandlersRegistered: boolean | null;
  errorMessage: string | null;
  prompterApiType: string;
  pingType: string;
  pingResult: string | null;
  appPath: string | null;
  cwd: string | null;
  mainDirname: string | null;
  preloadPath: string | null;
  preloadExists: boolean | null;
  isDev: boolean | null;
  viteDevServerUrl: string | null;
  preloadErrorMessage: string | null;
  preloadErrorStack: string | null;
  preloadDiagnosticStarted: boolean | null;
  preloadDiagnosticExposed: boolean | null;
  preloadDiagnosticErrorMessage: string | null;
  preloadDiagnosticErrorStack: string | null;
  localWhisperSidecarExecutablePath: string | null;
  localWhisperSidecarScriptPath: string | null;
  localWhisperModelPath: string | null;
  localWhisperSidecarWorkingDirectory: string | null;
  localWhisperUsesBundledSidecar: boolean | null;
  localWhisperSidecarProcessId: number | null;
};

export type PreloadExposeDiagnostics = {
  started: boolean;
  exposed: boolean;
  errorMessage: string | null;
  errorStack: string | null;
};

export type MainPreloadError = {
  preloadPath: string;
  message: string;
  stack: string | null;
};

export type LocalWhisperStatus = {
  providerId: 'local-whisper';
  configured: boolean;
  sidecarRunning: boolean;
  modelPhase: LocalWhisperSidecarPhase;
  listening: boolean;
  status: AsrStatus;
  lastTranscriptDelta: string;
  errorMessage: string | null;
  mic: MicCaptureDiagnostics;
  chunk: LocalWhisperChunkDiagnostics;
  transcriptHistory: AsrTranscriptHistoryItem[];
  bridge: ElectronBridgeDiagnostics;
};

export type LocalWhisperTranscriptResult = {
  text: string;
  durationSeconds?: number;
};
