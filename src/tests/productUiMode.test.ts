import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_WHISPER_STATUS } from '../asr/LocalWhisperAsrProvider';
import { ControlPanel, getTabletProductStatus } from '../components/ControlPanel';
import { buildManuscript } from '../domain/manuscript';
import type {
  AlignmentBufferDebug,
  AlignmentResult,
  LiveAsrConfigStatus,
  LiveAsrConnectionStatus
} from '../domain/types';
import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_LOCAL_WHISPER_SETTINGS,
  DEFAULT_MOCK_SCRIPT,
  SAMPLE_MANUSCRIPT
} from '../state/appStore';
import type { ServerStatusSummary } from '../../shared/protocol/messages';

const model = buildManuscript(SAMPLE_MANUSCRIPT);

const liveConfig: LiveAsrConfigStatus = {
  enabled: true,
  configured: true,
  providerId: 'openai-realtime',
  model: 'gpt-realtime-whisper',
  language: 'en',
  promptConfigured: false
};

const liveStatus: LiveAsrConnectionStatus = {
  providerId: 'openai-realtime',
  configured: true,
  connected: false,
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null
};

const alignment: AlignmentResult = {
  tokenIndex: 0,
  sentenceIndex: 0,
  paragraphIndex: 0,
  confidence: 0,
  matchedText: '',
  reason: 'Waiting for transcript.',
  searchWindow: {
    fromToken: 0,
    toToken: model.tokens.length
  }
};

const alignmentBufferDebug: AlignmentBufferDebug = {
  source: '',
  rawTranscript: '',
  normalizedTokens: [],
  retainedTokens: [],
  rollingBufferTokens: [],
  provisionalBufferTokens: [],
  evaluationBufferTokens: [],
  matchedText: '',
  confidence: 0,
  moveDecision: 'Waiting for transcript.',
  moveToTokenCalled: false,
  retentionDecision: 'none',
  retentionReason: 'No transcript processed yet.'
};

function renderControlPanel(developerMode: boolean) {
  const localWhisperStatus = {
    ...DEFAULT_LOCAL_WHISPER_STATUS,
    modelPhase: 'ready' as const,
    bridge: {
      ...DEFAULT_LOCAL_WHISPER_STATUS.bridge,
      electronBridgeAvailable: true,
      localWhisperBridgeAvailable: true,
      ipcHandlersRegistered: true,
      errorMessage: null,
      prompterApiType: 'object',
      pingType: 'function',
      pingResult: 'pong'
    }
  };

  return renderToStaticMarkup(
    React.createElement(ControlPanel, {
      projectTitle: 'Narration Session',
      onProjectTitleChange: vi.fn(),
      manuscriptText: SAMPLE_MANUSCRIPT,
      onManuscriptTextChange: vi.fn(),
      onImportTxt: vi.fn(),
      manuscriptImportError: null,
      onLocalFileSelected: vi.fn(),
      fileInputRef: { current: null } as React.RefObject<HTMLInputElement>,
      model,
      selectedAsrProviderId: 'local-whisper',
      onSelectedAsrProviderChange: vi.fn(),
      liveConfig,
      liveStatus,
      localWhisperSettings: DEFAULT_LOCAL_WHISPER_SETTINGS,
      appliedLocalWhisperSettings: DEFAULT_LOCAL_WHISPER_SETTINGS,
      onLocalWhisperSettingsChange: vi.fn(),
      localWhisperSettingsDirty: false,
      onApplyLocalWhisperSettings: vi.fn(),
      onRestartLocalWhisper: vi.fn(),
      localWhisperStatus,
      narrationStatus: {
        label: 'Idle',
        tone: 'idle',
        warning: null
      },
      developerMode,
      onToggleDeveloperMode: vi.fn(),
      isListening: false,
      isMockPlaying: false,
      inputLevel: 0,
      followState: 'manual',
      confidence: 0,
      currentSentenceIndex: 0,
      currentParagraphIndex: 0,
      onStartStop: vi.fn(),
      onStartMicMonitor: vi.fn(),
      onStopMicMonitor: vi.fn(),
      onToggleFollow: vi.fn(),
      onTogglePause: vi.fn(),
      onStepSentence: vi.fn(),
      onStepParagraph: vi.fn(),
      onResync: vi.fn(),
      manualTranscript: '',
      onManualTranscriptChange: vi.fn(),
      onInjectManual: vi.fn(),
      mockScript: DEFAULT_MOCK_SCRIPT,
      onMockScriptChange: vi.fn(),
      onPlayMock: vi.fn(),
      onStopMock: vi.fn(),
      slowMock: false,
      onSlowMockChange: vi.fn(),
      searchQuery: '',
      onSearchQueryChange: vi.fn(),
      onSearchJump: vi.fn(),
      settings: DEFAULT_DISPLAY_SETTINGS,
      onSettingsChange: vi.fn(),
      onTestSmoothScroll: vi.fn(),
      onResetTestScroll: vi.fn(),
      onToggleDebug: vi.fn(),
      onToggleFullScreen: vi.fn(),
      onToggleAlwaysOnTop: vi.fn(),
      debugVisible: false,
      deltas: [],
      transcriptBuffer: [],
      alignment,
      currentTokenIndex: 0,
      alignmentBufferDebug,
      traceLog: [],
      assistStatus: null,
      anchorDebug: null,
      scrollAnimationStatus: null,
      movementDecision: null,
      movementDecisionHistory: [],
      lastStartDiagnostic: null,
      tabletStatus: null,
      onPrepareTablet: vi.fn(),
      onQuitPrompter: vi.fn()
    })
  );
}

function tabletStatus(overrides: Partial<ServerStatusSummary> = {}): ServerStatusSummary {
  return {
    enabled: false,
    state: 'off',
    bindAddress: null,
    port: 43127,
    candidateAddresses: [],
    advertisedServiceName: null,
    pairingActive: false,
    pairingCode: null,
    pairingExpiresAtMs: null,
    pairedDeviceCount: 0,
    pairedDevices: [],
    connectedDevices: [],
    controllerDeviceId: null,
    controllerDisplayName: null,
    operatingMode: 'desktop',
    manuscriptLoaded: true,
    tabletNarrationActive: false,
    tabletStartDescription: 'Start from current desktop position',
    tabletResumeAvailable: true,
    transcriptAuthority: 'desktop',
    safeStorageAvailable: true,
    credentialStorage: 'encrypted',
    cleartextTransportWarning: '',
    lastError: null,
    ...overrides
  };
}

describe('product UI mode', () => {
  beforeEach(() => localStorage.clear());

  it('shows a narrator workflow and hides engineering controls by default', () => {
    const html = renderControlPanel(false);

    expect(html).toContain('Local Whisper ready');
    expect(html).toContain('Open manuscript');
    expect(html).toContain('Narration');
    expect(html).toContain('>Start<');
    expect(html).toContain('>Pause<');
    expect(html).toContain('>Stop<');
    expect(html).toContain('Tablet');
    expect(html).toContain('Quit');
    expect(html).toContain('Open Advanced');
    expect(html).not.toContain('Movement decision');
    expect(html).not.toContain('Mock Playback');
    expect(html).not.toContain('Live OpenAI Realtime');
    expect(html).not.toContain('Start Mic Monitor');
    expect(html).not.toContain('Bridge Diagnostics');
    expect(html).not.toContain('protocol');
    expect(html).not.toContain('socket');
  });

  it('shows developer diagnostics when developer mode is enabled', () => {
    const html = renderControlPanel(true);

    expect(html).toContain('Movement decision');
    expect(html).toContain('Advanced Diagnostics');
    expect(html).toContain('Mock');
    expect(html).toContain('Live OpenAI Realtime');
    expect(html).toContain('Leave Advanced');
    expect(html).toContain('Start Mic Monitor');
  });

  it('uses simple tablet status language without exposing transport details', () => {
    expect(getTabletProductStatus(tabletStatus()).label).toBe('Tablet is optional');
    expect(getTabletProductStatus(tabletStatus({
      enabled: true,
      state: 'pairing',
      pairingActive: true,
      pairingCode: '427913'
    }))).toMatchObject({
      label: 'Ready to pair',
      detail: 'Enter 427913 on the tablet.'
    });
    expect(getTabletProductStatus(tabletStatus({
      enabled: true,
      state: 'connected',
      connectedDevices: [{ deviceId: 'tab-1', displayName: 'Studio Tablet', remoteAddress: '192.168.1.8' }]
    }))).toMatchObject({
      label: 'Tablet connected',
      detail: 'Studio Tablet'
    });
  });
});
