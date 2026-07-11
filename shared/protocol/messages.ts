import type {
  AsrProviderId,
  DisplaySettings,
  FollowState,
  SessionCoordinatorState,
  TranscriptSource
} from '../session/SessionCoordinator.js';

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
};

export type AuthenticatePayload = {
  action: 'authenticate';
  deviceId: string;
  clientNonce: string;
  timestampMs: number;
  proof: string;
  protocolMajor: number;
  protocolMinor: number;
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

export type ServerCoordinatorUpdate = {
  origin: 'tablet';
  deviceId: string;
  state: SessionCoordinatorState;
};
