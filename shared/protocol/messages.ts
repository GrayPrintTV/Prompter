import type {
  AsrProviderId,
  DisplaySettings,
  FollowState,
  SessionCoordinatorState,
  TranscriptSource
} from '../session/SessionCoordinator.js';
import type { RuntimeSettings } from './runtime-settings.js';

export type { RuntimeSettings } from './runtime-settings.js';

export type ProtocolEnvelope<T = Record<string, unknown>> = {
  protocolMajor: number;
  protocolMinor: number;
  type: string;
  serverId: string;
  sessionId: string;
  connectionId: string;
  sequence: number;
  sentAtMs: number;
  payload: T;
};

export type BuildIdentityPayload = {
  versionName?: string;
  versionCode?: number;
  buildTimestamp?: string;
  gitHash?: string;
  dirty?: boolean;
  protocolMajor?: number;
  protocolMinor?: number;
};

export type RendererSessionSync = {
  rendererRevision: number;
  manuscriptText: string;
  manuscriptId: string;
  currentTokenIndex: number;
  followState: FollowState;
  displaySettings: DisplaySettings;
  selectedProviderId: AsrProviderId;
  transcriptSourceActive: boolean;
  sessionResetId: number;
};

export type RendererSyncResult = {
  accepted: boolean;
  duplicate: boolean;
  stale: boolean;
  serverSessionRevision: number;
  manuscriptRevision: number;
  reason: string;
};

export type ServerStatusSummary = {
  enabled: boolean;
  state: 'off' | 'starting' | 'available' | 'pairing' | 'connected' | 'error';
  bindAddress: string | null;
  port: number;
  candidateAddresses: string[];
  advertisedServiceName: string | null;
  pairingActive: boolean;
  pairingCode: string | null;
  pairingExpiresAtMs: number | null;
  pairedDeviceCount: number;
  pairedDevices: Array<{ deviceId: string; displayName: string; model: string; lastConnectedAt: number | null }>;
  connectedDevices: Array<{ deviceId: string; displayName: string; remoteAddress: string }>;
  controllerDeviceId: string | null;
  controllerDisplayName: string | null;
  operatingMode: 'desktop' | 'tablet';
  manuscriptLoaded: boolean;
  tabletNarrationActive: boolean;
  tabletStartDescription: string;
  tabletResumeAvailable: boolean;
  transcriptAuthority: 'desktop' | 'tablet' | 'manual';
  safeStorageAvailable: boolean;
  credentialStorage: 'encrypted' | 'plaintext-fallback';
  cleartextTransportWarning: string;
  lastError: string | null;
};

export type PairRequestPayload = {
  action: 'pairRequest';
  requestId: string;
  deviceId: string;
  deviceName: string;
  model?: string;
  pairingCode?: string;
  protocolMajor: number;
  protocolMinor: number;
  clientBuild?: BuildIdentityPayload;
};

export type AuthenticatePayload = {
  action: 'authenticate';
  deviceId: string;
  clientNonce: string;
  timestampMs: number;
  proof: string;
  protocolMajor: number;
  protocolMinor: number;
  clientBuild?: BuildIdentityPayload;
  cachedManuscriptHash?: string;
};

export type AudioStreamStartPayload = {
  action: 'start';
  streamId: string;
  sampleRate: 16000 | 48000;
  channels: 1;
  encoding: 'pcm-s16le';
  sequenceStart: number;
  captureTimestampMs: number;
  frameDurationMs: number;
};

export type AudioFrameMetadata = {
  streamId: string;
  sequence: number;
  captureTimestampMs: number;
  sampleRate: 16000 | 48000;
  channels: 1;
  encoding: 'pcm-s16le';
  sampleCount: number;
  flags?: number;
};

export type TabletManualRepositionPayload = {
  action: 'manualReposition';
  manuscriptRevision: number;
  visibleTokenIndex: number;
  visibleCharacter: number;
  sentenceIndex: number;
  paragraphIndex: number;
  direction: 'backward' | 'forward' | 'stationary';
  inputSource: 'touch' | 'pointer' | 'unknown';
  scrollContainer: string;
  detectedAtMs: number;
};

export type TabletManualRepositionResult = {
  accepted: boolean;
  reason: string;
  manuscriptRevision: number;
  visibleTokenIndex: number;
  sessionRevision: number;
};

export type TabletManualRepositionStatus = {
  status: 'holding' | 'reacquired';
  anchorTokenIndex: number;
  distanceTokens: number;
};

export type TabletManualFollowDiagnosticPayload = {
  action: 'manualFollowDiagnostic';
  timestampMs: number;
  sequence: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string;
  details: Record<string, string>;
};

export type MovementEventPayload = {
  sessionRevision: number;
  manuscriptRevision: number;
  confirmedTokenIndex: number;
  targetTokenIndex: number;
  targetCharacter: number;
  sentenceIndex: number;
  paragraphIndex: number;
  confidence: number;
  durationHintMs: number;
  classification: string;
  reason: string;
  manualRepositionStatus?: TabletManualRepositionStatus['status'];
  manualAnchorTokenIndex?: number;
  manualAnchorDistanceTokens?: number;
};

export type TranscriptEventPayload = {
  sessionRevision: number;
  manuscriptRevision: number;
  text: string;
  isFinal: boolean;
  source: TranscriptSource;
  confidence?: number;
  audioSequence?: number;
  requestId?: string;
  timestampMs: number;
  acceptedPosition: {
    tokenIndex: number;
    character: number;
    sentenceIndex: number;
    paragraphIndex: number;
  };
};

export type RuntimeSettingsPayload = RuntimeSettings;

export type ServerCoordinatorUpdate = {
  origin: 'tablet';
  deviceId: string | null;
  state: SessionCoordinatorState;
  movementSuppressedOnDesktop: boolean;
};

export type TabletModeStatus = {
  mode: 'desktop' | 'tablet';
  deviceId: string | null;
  deviceName: string | null;
  reason: string;
};
