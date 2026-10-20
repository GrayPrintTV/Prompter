import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ManualAsrProvider } from './asr/ManualAsrProvider';
import { MockAsrProvider } from './asr/MockAsrProvider';
import { DEFAULT_LOCAL_WHISPER_STATUS, LocalWhisperAsrProvider } from './asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from './asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions } from './asr/providerRegistry';
import { ControlPanel } from './components/ControlPanel';
import { NarrationBar } from './components/NarrationBar';
import { PrompterView } from './components/PrompterView';
import {
  buildManuscript,
  findParagraphIndexForSentence,
  findSentenceIndexForToken,
  searchManuscript,
  tokenIndexForParagraph,
  tokenIndexForSentence
} from './domain/manuscript';
import { cleanupImportedManuscriptText } from './domain/manuscriptImportCleanup';
import { shouldRecoverControlsFromHiddenLayout } from './domain/layoutRecovery';
import {
  type MovementDecisionInfo
} from './domain/movementDiagnostics';
import {
  deriveNarrationStatus,
  deriveTranscriptPipelineState,
  isBenignStartDiagnosticMessage,
  type StartDiagnostic
} from './domain/narrationStatus';
import type {
  AlignmentBufferDebug,
  AlignmentResult,
  AsrProviderId,
  AssistStatusInfo,
  DisplaySettings,
  FollowState,
  LiveAsrConfigStatus,
  LiveAsrConnectionStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  ManuscriptModel,
  ScrollAnimationStatusInfo,
  ScrollTestRequest,
  TranscriptDelta
} from './domain/types';
import {
  DEFAULT_DEVELOPER_MODE,
  DEFAULT_LOCAL_WHISPER_SETTINGS,
  DEFAULT_MOCK_SCRIPT,
  resolveInitialDeveloperMode,
  resolveInitialDisplaySettings,
  SAMPLE_MANUSCRIPT
} from './state/appStore';
import { loadSession, saveSession } from './state/projectStore';
import { isEditableTarget } from './shortcuts/shortcuts';
import {
  EMPTY_SESSION_ALIGNMENT_DEBUG,
  SessionCoordinator,
  type RecordMovementParams,
  type SessionCoordinatorState,
  type VisibleReacquireAnchor
} from './session/SessionCoordinator';
import type { ServerStatusSummary, TabletModeStatus, UsbTransportMode } from '../shared/protocol/messages';
import { rendererProjectionForTabletUpdate } from './session/tabletAuthority';
import type { ManualScrollInputSource } from './domain/manualFollow';
import { LocalWhisperTelemetryAccumulator } from './diagnostics/LocalWhisperTelemetry';
import { ManuscriptPrepWorkspace } from './components/ManuscriptPrepWorkspace';

function emptyAlignment(model: ManuscriptModel, tokenIndex: number): AlignmentResult {
  const sentenceIndex = findSentenceIndexForToken(model, tokenIndex);
  return {
    tokenIndex,
    sentenceIndex,
    paragraphIndex: findParagraphIndexForSentence(model, sentenceIndex),
    confidence: 0,
    matchedText: '',
    reason: 'Waiting for transcript.',
    searchWindow: { fromToken: 0, toToken: model.tokens.length }
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const DEFAULT_LIVE_CONFIG: LiveAsrConfigStatus = {
  enabled: false,
  configured: false,
  providerId: 'openai-realtime',
  model: 'gpt-realtime-whisper',
  language: 'en',
  promptConfigured: false
};

const DEFAULT_LIVE_STATUS: LiveAsrConnectionStatus = {
  providerId: 'openai-realtime',
  configured: false,
  connected: false,
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null
};

const EMPTY_ALIGNMENT_BUFFER_DEBUG = EMPTY_SESSION_ALIGNMENT_DEBUG;

const DISPLAY_SETTINGS_MIGRATION_KEY = 'narration-prompter.display-settings-v3-reading-band-migrated';
const MIC_STARTUP_GRACE_MS = 2000;

function hasDisplaySettingsMigrationRun() {
  try {
    return localStorage.getItem(DISPLAY_SETTINGS_MIGRATION_KEY) === 'true';
  } catch {
    return true;
  }
}

function markDisplaySettingsMigrationRun() {
  try {
    localStorage.setItem(DISPLAY_SETTINGS_MIGRATION_KEY, 'true');
  } catch {
    // Migration is only for local display preferences; storage failure is harmless.
  }
}

function localWhisperSettingsEqual(a: LocalWhisperSettings, b: LocalWhisperSettings) {
  return (
    a.pythonExecutablePath === b.pythonExecutablePath &&
    a.modelName === b.modelName &&
    a.device === b.device &&
    a.computeType === b.computeType &&
    a.chunkDurationSeconds === b.chunkDurationSeconds
  );
}

export default function App() {
  const stored = useMemo(() => loadSession(), []);
  const shouldRunDisplaySettingsMigration = useMemo(() => !hasDisplaySettingsMigrationRun(), []);
  const initialLocalWhisperSettings = useMemo(() => ({
    ...DEFAULT_LOCAL_WHISPER_SETTINGS,
    ...stored?.localWhisperSettings
  }), [stored]);
  const initialDeveloperMode = useMemo(
    () => resolveInitialDeveloperMode(stored?.developerMode ?? DEFAULT_DEVELOPER_MODE),
    [stored]
  );
  const initialStoredProviderId = stored?.selectedAsrProviderId as AsrProviderId | undefined;
  const initialProviderAllowedInNormalMode =
    initialStoredProviderId === 'manual' || initialStoredProviderId === 'local-whisper';
  const [projectTitle, setProjectTitle] = useState(stored?.projectTitle ?? 'Narration Session');
  const [approvedManuscript, setApprovedManuscript] = useState(stored?.approvedManuscript);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [manuscriptText, setManuscriptText] = useState(stored?.manuscriptText ?? SAMPLE_MANUSCRIPT);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>(() =>
    resolveInitialDisplaySettings(stored?.displaySettings, {
      migrateLegacyNarrationDefaults: shouldRunDisplaySettingsMigration
    })
  );
  const [currentTokenIndex, setCurrentTokenIndex] = useState(stored?.currentTokenIndex ?? 0);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(stored?.currentSentenceIndex ?? 0);
  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(stored?.currentParagraphIndex ?? 0);
  const [followState, setFollowState] = useState<FollowState>(stored?.followState ?? 'manual');
  const [manualTranscript, setManualTranscript] = useState('');
  const [mockScript, setMockScript] = useState(stored?.mockScript ?? DEFAULT_MOCK_SCRIPT);
  const [liveConfig, setLiveConfig] = useState<LiveAsrConfigStatus>(DEFAULT_LIVE_CONFIG);
  const [liveStatus, setLiveStatus] = useState<LiveAsrConnectionStatus>(DEFAULT_LIVE_STATUS);
  const [localWhisperSettings, setLocalWhisperSettings] = useState<LocalWhisperSettings>(initialLocalWhisperSettings);
  const [localWhisperDraftSettings, setLocalWhisperDraftSettings] =
    useState<LocalWhisperSettings>(initialLocalWhisperSettings);
  const [localWhisperStatus, setLocalWhisperStatus] = useState<LocalWhisperStatus>(DEFAULT_LOCAL_WHISPER_STATUS);
  const [developerMode, setDeveloperMode] = useState(initialDeveloperMode);
  const [selectedAsrProviderId, setSelectedAsrProviderId] = useState<AsrProviderId>(
    coerceSelectedProvider(
      initialDeveloperMode || initialProviderAllowedInNormalMode
        ? initialStoredProviderId
        : undefined,
      DEFAULT_LIVE_CONFIG,
      initialLocalWhisperSettings
    )
  );
  const [isListening, setIsListening] = useState(false);
  const [isMockPlaying, setIsMockPlaying] = useState(false);
  const [debugVisible, setDebugVisible] = useState(stored?.debugVisible ?? false);
  const [controlsVisible, setControlsVisible] = useState(() => {
    try {
      return localStorage.getItem('narration-prompter.controls-visible') !== 'false';
    } catch {
      return true;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [manuscriptImportError, setManuscriptImportError] = useState<string | null>(null);
  const [transcriptBuffer, setTranscriptBuffer] = useState<string[]>([]);
  const [deltas, setDeltas] = useState<TranscriptDelta[]>([]);
  const [traceLog, setTraceLog] = useState<string[]>([]);
  const [slowMock, setSlowMock] = useState(false);
  const [assistStatus, setAssistStatus] = useState<AssistStatusInfo | null>(null);
  const [anchorDebug, setAnchorDebug] = useState(null);
  const [scrollTestRequest, setScrollTestRequest] = useState<ScrollTestRequest | null>(null);
  const [scrollAnimationStatus, setScrollAnimationStatus] = useState<ScrollAnimationStatusInfo | null>(null);
  const [movementDecision, setMovementDecision] = useState<MovementDecisionInfo | null>(null);
  const [movementDecisionHistory, setMovementDecisionHistory] = useState<MovementDecisionInfo[]>([]);
  const [lastStartDiagnostic, setLastStartDiagnostic] = useState<StartDiagnostic | null>(null);
  const [micStartupGraceActive, setMicStartupGraceActive] = useState(false);
  const [manualReacquireAnchor, setManualReacquireAnchor] =
    useState<VisibleReacquireAnchor | null>(null);
  const [startupVisibleAnchorRequestId, setStartupVisibleAnchorRequestId] = useState(0);
  const [alignmentBufferDebug, setAlignmentBufferDebug] = useState<AlignmentBufferDebug>(
    EMPTY_ALIGNMENT_BUFFER_DEBUG
  );
  const [inputLevel, setInputLevel] = useState(0);
  const [sessionResetId, setSessionResetId] = useState(0);
  const [tabletStatus, setTabletStatus] = useState<ServerStatusSummary | null>(null);
  const [tabletModeStatus, setTabletModeStatus] = useState<TabletModeStatus>({
    mode: 'desktop',
    deviceId: null,
    deviceName: null,
    reason: 'No tablet controller lease'
  });
  const [manuscriptPrepOpen, setManuscriptPrepOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const prompterStageRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const stage = prompterStageRef.current;
    const toolbar = stage?.querySelector<HTMLElement>('.narration-bar');
    if (!stage || !toolbar) return;

    const updateToolbarInset = () => {
      const height = Math.ceil(toolbar.getBoundingClientRect().height);
      stage.style.setProperty('--reader-toolbar-height', `${height}px`);
    };
    updateToolbarInset();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateToolbarInset);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  const manualProviderRef = useRef(new ManualAsrProvider());
  const mockProviderRef = useRef(new MockAsrProvider());
  const liveProviderRef = useRef(new OpenAiRealtimeAsrProvider());
  const localWhisperTelemetryRef = useRef(new LocalWhisperTelemetryAccumulator());
  const localWhisperProviderRef = useRef(
    new LocalWhisperAsrProvider(initialLocalWhisperSettings, {
      onTelemetryEvent: (event) => localWhisperTelemetryRef.current.recordProviderEvent(event)
    })
  );
  const scrollTestIdRef = useRef(0);
  const startupVisibleAnchorRequestIdRef = useRef(0);
  const lastAssistMovementKeyRef = useRef<string | null>(null);
  const manuscript = useMemo(() => buildManuscript(manuscriptText), [manuscriptText]);
  const sessionCoordinatorRef = useRef<SessionCoordinator | null>(null);
  if (!sessionCoordinatorRef.current) {
    sessionCoordinatorRef.current = new SessionCoordinator({
      manuscript,
      currentTokenIndex,
      followState,
      displaySettings
    });
  }
  const sessionCoordinator = sessionCoordinatorRef.current;
  const manuscriptRef = useRef(manuscript);
  const currentTokenRef = useRef(currentTokenIndex);
  const followStateRef = useRef(followState);
  const [alignment, setAlignment] = useState<AlignmentResult>(() => emptyAlignment(manuscript, currentTokenIndex));
  const alignmentRef = useRef(alignment);
  const selectedAsrProviderRef = useRef(selectedAsrProviderId);
  const slowMockRef = useRef(false);
  const displaySettingsRef = useRef<DisplaySettings | null>(null);
  const anchorDebugRef = useRef<any>(null);
  const activeStartAttemptRef = useRef<{
    providerId: AsrProviderId;
    source: string;
    lastIssue: StartDiagnostic | null;
  } | null>(null);
  const micStartupGraceTimeoutRef = useRef<number | null>(null);
  const rendererSyncRevisionRef = useRef(0);
  const lastRendererSyncFingerprintRef = useRef('');
  const tabletModeRef = useRef(false);

  useEffect(() => {
    if (shouldRunDisplaySettingsMigration) {
      markDisplaySettingsMigrationRun();
    }
  }, [shouldRunDisplaySettingsMigration]);

  useEffect(() => {
    displaySettingsRef.current = displaySettings;
    sessionCoordinator.setDisplaySettings(displaySettings);
  }, [displaySettings, sessionCoordinator]);

  useEffect(() => {
    alignmentRef.current = alignment;
  }, [alignment]);

  useEffect(() => {
    slowMockRef.current = slowMock;
  }, [slowMock]);

  useEffect(() => {
    manuscriptRef.current = manuscript;
    const clamped = clamp(currentTokenRef.current, 0, Math.max(manuscript.tokens.length - 1, 0));
    const sentenceIndex = findSentenceIndexForToken(manuscript, clamped);
    currentTokenRef.current = clamped;
    setCurrentTokenIndex(clamped);
    setCurrentSentenceIndex(sentenceIndex);
    setCurrentParagraphIndex(findParagraphIndexForSentence(manuscript, sentenceIndex));
    setAlignment(emptyAlignment(manuscript, clamped));
    sessionCoordinator.replaceManuscript(manuscript, clamped);
    setAlignmentBufferDebug(EMPTY_ALIGNMENT_BUFFER_DEBUG);
    setTranscriptBuffer([]);
    setManualReacquireAnchor(null);
    setMovementDecision(null);
    setMovementDecisionHistory([]);
  }, [manuscript, sessionCoordinator]);

  useEffect(() => {
    currentTokenRef.current = currentTokenIndex;
  }, [currentTokenIndex]);

  useEffect(() => {
    followStateRef.current = followState;
    if (sessionCoordinator.getState().followState !== followState) {
      sessionCoordinator.setFollowState(followState);
    }
  }, [followState, sessionCoordinator]);

  useEffect(() => {
    selectedAsrProviderRef.current = selectedAsrProviderId;
  }, [selectedAsrProviderId]);

  useEffect(() => () => {
    if (micStartupGraceTimeoutRef.current !== null) {
      window.clearTimeout(micStartupGraceTimeoutRef.current);
    }
  }, []);

  const clearMicStartupGrace = useCallback(() => {
    if (micStartupGraceTimeoutRef.current !== null) {
      window.clearTimeout(micStartupGraceTimeoutRef.current);
      micStartupGraceTimeoutRef.current = null;
    }
    setMicStartupGraceActive(false);
  }, []);

  const beginMicStartupGrace = useCallback(() => {
    if (micStartupGraceTimeoutRef.current !== null) {
      window.clearTimeout(micStartupGraceTimeoutRef.current);
      micStartupGraceTimeoutRef.current = null;
    }
    setMicStartupGraceActive(true);
  }, []);

  const settleMicStartupGrace = useCallback(() => {
    if (micStartupGraceTimeoutRef.current !== null) {
      window.clearTimeout(micStartupGraceTimeoutRef.current);
    }
    micStartupGraceTimeoutRef.current = window.setTimeout(() => {
      micStartupGraceTimeoutRef.current = null;
      setMicStartupGraceActive(false);
    }, MIC_STARTUP_GRACE_MS);
  }, []);

  const applyCoordinatorState = useCallback((state: SessionCoordinatorState) => {
    currentTokenRef.current = state.currentTokenIndex;
    followStateRef.current = state.followState;
    alignmentRef.current = state.alignment;
    setCurrentTokenIndex(state.currentTokenIndex);
    setCurrentSentenceIndex(state.currentSentenceIndex);
    setCurrentParagraphIndex(state.currentParagraphIndex);
    setFollowState(state.followState);
    setAlignment(state.alignment);
    setTranscriptBuffer(state.transcriptBuffer);
    setAlignmentBufferDebug(state.alignmentBufferDebug);
    setManualReacquireAnchor(state.manualReacquireAnchor);
    setMovementDecision(state.movementDecision);
    setMovementDecisionHistory(state.movementDecisionHistory);
  }, []);

  const applyCoordinatorDiagnostics = useCallback((state: SessionCoordinatorState) => {
    setAlignment(state.alignment);
    setTranscriptBuffer(state.transcriptBuffer);
    setAlignmentBufferDebug(state.alignmentBufferDebug);
    setMovementDecision(state.movementDecision);
    setMovementDecisionHistory(state.movementDecisionHistory);
  }, []);

  useEffect(() => {
    const api = window.prompterApi;
    if (!api?.getServerStatus) return;
    void api.getServerStatus().then(setTabletStatus).catch(() => setTabletStatus(null));
    const unsubscribe = api.onServerStatus(setTabletStatus);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const api = window.prompterApi;
    if (!api?.syncServerSession) return;
    const timer = window.setTimeout(() => {
      const candidate = {
        manuscriptText,
        manuscriptId: `desktop:${projectTitle}`,
        currentTokenIndex,
        followState,
        displaySettings,
        selectedProviderId: selectedAsrProviderId,
        transcriptSourceActive: isListening || isMockPlaying,
        sessionResetId
      };
      const fingerprint = JSON.stringify(candidate);
      if (fingerprint === lastRendererSyncFingerprintRef.current) return;
      lastRendererSyncFingerprintRef.current = fingerprint;
      rendererSyncRevisionRef.current += 1;
      void api.syncServerSession({ rendererRevision: rendererSyncRevisionRef.current, ...candidate }).catch(() => {
        // The desktop remains fully usable if main-process synchronization is unavailable.
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [currentTokenIndex, displaySettings, followState, isListening, isMockPlaying, manuscriptText, projectTitle, selectedAsrProviderId, sessionResetId]);

  const moveToToken = useCallback((tokenIndex: number, nextState: FollowState = 'manual') => {
    applyCoordinatorState(sessionCoordinator.setPosition(tokenIndex, nextState));
  }, [applyCoordinatorState, sessionCoordinator]);

  const appendTrace = useCallback((entry: string) => {
    setTraceLog((prev) => [...prev.slice(-39), entry]);
  }, []);

  const recordMovementDecision = useCallback((params: RecordMovementParams) => {
    sessionCoordinator.recordMovement(params);
    const state = sessionCoordinator.getState();
    setMovementDecision(state.movementDecision);
    setMovementDecisionHistory(state.movementDecisionHistory);
  }, [sessionCoordinator]);

  const requestSmoothScrollTest = useCallback((lineCount: number) => {
    scrollTestIdRef.current += 1;
    const safeLineCount = Math.max(1, Math.round(lineCount));
    appendTrace(`scroll test request: ${safeLineCount} lines`);
    setScrollTestRequest({
      id: scrollTestIdRef.current,
      type: 'lines',
      lineCount: safeLineCount
    });
  }, [appendTrace]);

  const requestResetScrollTest = useCallback(() => {
    scrollTestIdRef.current += 1;
    appendTrace('scroll test request: reset to top');
    setScrollTestRequest({
      id: scrollTestIdRef.current,
      type: 'reset'
    });
  }, [appendTrace]);

  const clearManualReacquireAnchor = useCallback(() => {
    sessionCoordinator.clearVisibleReacquireAnchor();
    setManualReacquireAnchor(null);
  }, [sessionCoordinator]);

  const requestStartupVisibleAnchor = useCallback(async () => {
    const existingAnchor = sessionCoordinator.getState().manualReacquireAnchor;
    if (existingAnchor && existingAnchor.source !== 'startup') {
      appendTrace(`manual anchor preserved across start token=${existingAnchor.visibleTokenIndex}`);
      return;
    }
    clearManualReacquireAnchor();
    startupVisibleAnchorRequestIdRef.current += 1;
    setStartupVisibleAnchorRequestId(startupVisibleAnchorRequestIdRef.current);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
  }, [appendTrace, clearManualReacquireAnchor, sessionCoordinator]);

  const enterFollowing = useCallback(() => {
    applyCoordinatorState(sessionCoordinator.setFollowState('following'));
  }, [applyCoordinatorState, sessionCoordinator]);

  const resetAlignmentContext = useCallback(() => {
    clearMicStartupGrace();
    activeStartAttemptRef.current = null;
    setSessionResetId((value) => value + 1);
    sessionCoordinator.resetTranscriptContext();
    setTranscriptBuffer([]);
    setAlignmentBufferDebug(EMPTY_ALIGNMENT_BUFFER_DEBUG);
    setManualReacquireAnchor(null);
  }, [clearMicStartupGrace, sessionCoordinator]);

  const onTraceScroll = useCallback((info: { sentenceIndex: number; didScroll: boolean; reason: string }) => {
    const r = info.reason || '';
    if (r.includes('assist cruise')) {
      const ds = displaySettingsRef.current;
      const extra = ds ? ` | assist continuous=${ds.continuousAssistScroll ? 1 : 0} speed=${ds.assistScrollSpeed} feel=${ds.assistCorrectionFeel}` : '';
      appendTrace(`scroll s${info.sentenceIndex} ${info.didScroll ? 'SCROLLED' : 'NO-SCROLL'} (${r})${extra}`);
    } else {
      appendTrace(`scroll s${info.sentenceIndex} ${info.didScroll ? 'SCROLLED' : 'NO-SCROLL'} (${info.reason})`);
    }
    const isLiveCorrectionEvent =
      r.includes('animation started source=live') ||
      r.includes('animation retargeted source=live') ||
      r.includes('correction completed; animation completed source=live') ||
      r.includes('already in reading band');
    if (isLiveCorrectionEvent) {
      recordMovementDecision({
        source: 'scroll',
        confirmedTokenIndex: anchorDebugRef.current?.confirmedToken ?? currentTokenRef.current,
        proposedTargetTokenIndex: anchorDebugRef.current?.targetToken,
        followState: followStateRef.current,
        finalMovement: r.includes('already in reading band') ? 'held' : 'corrected',
        engineReason: r,
        alignmentContext: 'scroll correction event'
      });
    }
  }, [appendTrace, recordMovementDecision]);

  const onAssistStatus = useCallback((info: AssistStatusInfo) => {
    setAssistStatus(info);
    // also surface key changes in trace for diagnostics (but UI status is the primary per req)
    if (info.state && info.state !== 'OFF') {
      appendTrace(`assist status: ${info.state}${info.cruiseVelocityPxPerSec != null ? ` vel=${Math.round(info.cruiseVelocityPxPerSec)}px/s` : ''}${info.estimatedPaceLinesPerMin != null ? ` pace=${info.estimatedPaceLinesPerMin}lpm` : ''}`);
    }
    const movementKey = `${info.enabled ? 1 : 0}|${info.state}|${info.reason ?? ''}`;
    if (info.state && info.state !== 'OFF' && movementKey !== lastAssistMovementKeyRef.current) {
      lastAssistMovementKeyRef.current = movementKey;
      const state = info.state.toLowerCase();
      const isCruising = state.includes('cruising') || state.includes('slowed');
      recordMovementDecision({
        source: 'assist',
        confirmedTokenIndex: sessionCoordinator.getFreshAnchorTokenIndex() ?? currentTokenRef.current,
        followState: followStateRef.current,
        finalMovement: isCruising ? 'only Assist-cruised' : 'held',
        confidence: isCruising ? alignmentRef.current.confidence : 0,
        engineReason: info.reason ?? info.state,
        alignmentContext: `assist ${info.state}`
      });
    }
  }, [appendTrace, recordMovementDecision, sessionCoordinator]);

  const onAnchorDebug = useCallback((info: any) => {
    anchorDebugRef.current = info;
    setAnchorDebug(info);
  }, []);

  const onScrollAnimationStatus = useCallback((info: ScrollAnimationStatusInfo) => {
    setScrollAnimationStatus(info);
    if (info.source === 'live' && (info.status === 'direct scroll' || info.status === 'first frame')) {
      localWhisperTelemetryRef.current.recordVisibleMovement();
    }
  }, []);

  const onStartupVisibleAnchor = useCallback((info: {
    requestId: number;
    visibleTokenIndex: number;
    scrollTop: number;
  }) => {
    if (info.requestId !== startupVisibleAnchorRequestIdRef.current) return;
    const hadFreshConfirmedAnchor = sessionCoordinator.hasFreshAnchor();
    const anchor: VisibleReacquireAnchor = {
      source: 'startup',
      visibleTokenIndex: info.visibleTokenIndex,
      detectedAtMs: Date.now(),
      direction: 'stationary',
      hadFreshConfirmedAnchor
    };
    applyCoordinatorState(sessionCoordinator.setVisibleReacquireAnchor(anchor, 'startup'));
    appendTrace(
      `startup visible anchor set token=${info.visibleTokenIndex} scrollTop=${info.scrollTop.toFixed(1)} freshAnchor=${hadFreshConfirmedAnchor ? 'yes' : 'no'}`
    );
    recordMovementDecision({
      source: 'startup-visible-anchor',
      previousTokenIndex: currentTokenRef.current,
      confirmedTokenIndex: currentTokenRef.current,
      proposedTargetTokenIndex: info.visibleTokenIndex,
      confidence: 0,
      followState: 'holding',
      finalMovement: 'held',
      engineReason: `startup visible anchor set; token=${info.visibleTokenIndex}`,
      alignmentContext: `startup visible anchor set; visible anchor token=${info.visibleTokenIndex}; fresh confirmed anchor=${hadFreshConfirmedAnchor ? 'yes' : 'no'}`,
      visibleAnchorTokenIndex: info.visibleTokenIndex
    });
  }, [appendTrace, applyCoordinatorState, recordMovementDecision, sessionCoordinator]);

  const onManualScroll = useCallback((info: {
    visibleTokenIndex: number;
    scrollTop: number;
    direction: 'backward' | 'forward' | 'stationary';
    source: ManualScrollInputSource;
    correctionCancelled: boolean;
    detectedAtMs: number;
  }) => {
    const previousTokenIndex = currentTokenRef.current;
    const anchor: VisibleReacquireAnchor = {
      source: 'manual-scroll',
      visibleTokenIndex: info.visibleTokenIndex,
      detectedAtMs: info.detectedAtMs,
      direction: info.direction,
      hadFreshConfirmedAnchor: sessionCoordinator.hasFreshAnchor()
    };
    applyCoordinatorState(sessionCoordinator.setVisibleReacquireAnchor(anchor, 'manual'));
    appendTrace(
      `manual scroll detected source=${info.source} direction=${info.direction}; auto-follow suppressed; correction=${info.correctionCancelled ? 'cancelled' : 'idle'}; visible anchor chosen token=${info.visibleTokenIndex} scrollTop=${info.scrollTop.toFixed(1)}; manual anchor accepted/rebased`
    );
    recordMovementDecision({
      source: `manual-scroll:${info.source}`,
      previousTokenIndex,
      confirmedTokenIndex: info.visibleTokenIndex,
      proposedTargetTokenIndex: info.visibleTokenIndex,
      confidence: 0,
      followState: 'holding',
      finalMovement: 'held',
      engineReason: `manual scroll detected source=${info.source}; visible anchor token=${info.visibleTokenIndex}`,
      alignmentContext: `manual scroll detected; visible anchor token=${info.visibleTokenIndex}; direction=${info.direction}; source=${info.source}; auto-follow suppressed`,
      visibleAnchorTokenIndex: info.visibleTokenIndex
    });
  }, [appendTrace, applyCoordinatorState, recordMovementDecision, sessionCoordinator]);

  // Trace assist param changes (enabled/speed/feel) when user adjusts Display controls. Runs after appendTrace exists.
  useEffect(() => {
    appendTrace(`assist settings: continuous=${displaySettings.continuousAssistScroll ? 1 : 0} speed=${displaySettings.assistScrollSpeed} feel=${displaySettings.assistCorrectionFeel}`);
  }, [displaySettings.continuousAssistScroll, displaySettings.assistScrollSpeed, displaySettings.assistCorrectionFeel, appendTrace]);

  const processDelta = useCallback((delta: TranscriptDelta) => {
    if (tabletModeRef.current) return;
    setDeltas((previous) => [...previous.slice(-24), delta]);
    const result = sessionCoordinator.processTranscript(delta);
    const acceptedAtMs = Date.now();
    if (delta.source === 'local-whisper') {
      const decision = result.state.movementDecision;
      const rejectedAsStale = result.state.alignmentBufferDebug.moveDecision === 'ignored stale pre-anchor transcript';
      const alignmentAccepted = decision?.finalMovement === 'accepted' || decision?.finalMovement === 'corrected';
      const debug = result.state.alignmentBufferDebug;
      const rejection = alignmentAccepted ? undefined : {
        category: debug.rejectionCategory ?? (rejectedAsStale ? 'stale-pre-anchor' : 'unknown'),
        currentTokenIndex: result.state.currentTokenIndex,
        candidateStartTokenIndex: debug.selectedCandidateStartTokenIndex ?? null,
        candidateEndTokenIndex: debug.selectedCandidateEndTokenIndex ?? null,
        confidence: Number.isFinite(debug.confidence) ? Math.round(debug.confidence * 1_000) / 1_000 : null,
        matchedWordCount: debug.newDeltaMatchedWordCount ?? null,
        distinctiveMatchedWordCount: debug.newDeltaDistinctiveMatchedWordCount ?? null,
        lowConfidenceCount: debug.lowConfidenceCount ?? null,
        followState: result.state.followState,
        transcriptAgeMs: delta.telemetry ? Math.max(0, acceptedAtMs - delta.telemetry.capturedAtMs) : null,
        rendererBacklogMs: delta.telemetry
          ? Math.max(0, delta.telemetry.rendererDispatchedAtMs - (delta.telemetry.capturedAtMs + delta.telemetry.audioDurationMs))
          : null
      };
      localWhisperTelemetryRef.current.recordCoordinatorResult({
        telemetry: delta.telemetry,
        acceptedAtMs,
        rejectedAsStale,
        alignmentAccepted,
        rejection,
        visibleMovementExpected: Boolean(
          alignmentAccepted && decision && decision.confirmedTokenIndex !== decision.previousAnchorTokenIndex
        )
      });
    }
    for (const trace of result.traces) appendTrace(trace);
    setInputLevel(result.inputLevel);
    applyCoordinatorState(result.state);
  }, [appendTrace, applyCoordinatorState, sessionCoordinator]);

  useEffect(() => {
    const manualOff = manualProviderRef.current.onDelta(processDelta);
    const mockOff = mockProviderRef.current.onDelta(processDelta);
    const liveOff = liveProviderRef.current.onDelta(processDelta);
    const liveStatusOff = liveProviderRef.current.onConnectionStatus(setLiveStatus);
    const localWhisperOff = localWhisperProviderRef.current.onDelta(processDelta);
    const localWhisperStatusOff = localWhisperProviderRef.current.onConnectionStatus((status) => {
      setLocalWhisperStatus(status);
      const attempt = activeStartAttemptRef.current;
      if (!attempt || attempt.providerId !== 'local-whisper') return;

      const errorMessage = status.errorMessage ?? status.mic.errorMessage;
      const warningMessage = status.chunk.warningMessage;
      const message = errorMessage ?? warningMessage;
      if (!message || isBenignStartDiagnosticMessage(message)) return;

      const level = errorMessage ? 'error' : 'warning';
      if (attempt.lastIssue?.message === message && attempt.lastIssue.level === level) return;

      const diagnostic: StartDiagnostic = {
        timestampMs: Date.now(),
        source: attempt.source,
        level,
        message,
        blocking: false,
        recovered: false
      };
      attempt.lastIssue = diagnostic;
      setLastStartDiagnostic(diagnostic);
    });
    const doneOff = mockProviderRef.current.onDone(() => {
      setIsMockPlaying(false);
      if (selectedAsrProviderRef.current === 'mock') {
        applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
      }
    });
    return () => {
      manualOff();
      mockOff();
      liveOff();
      liveStatusOff();
      localWhisperOff();
      localWhisperStatusOff();
      doneOff();
    };
  }, [applyCoordinatorState, processDelta, sessionCoordinator]);

  useEffect(() => {
    localWhisperProviderRef.current.setSettings(localWhisperSettings);
  }, [localWhisperSettings]);

  useEffect(() => {
    try {
      localStorage.setItem('narration-prompter.controls-visible', controlsVisible ? 'true' : 'false');
    } catch {
      // Controls visibility is a convenience preference; persistence failure is harmless.
    }
  }, [controlsVisible]);

  useEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;

    const forceLayoutCheck = () => {
      window.dispatchEvent(new Event('resize'));
      if (controlsVisible) return;

      const rect = prompterStageRef.current?.getBoundingClientRect();
      if (
        !rect ||
        shouldRecoverControlsFromHiddenLayout({
          controlsVisible,
          stageWidth: rect.width,
          stageHeight: rect.height
        })
      ) {
        setControlsVisible(true);
      }
    };

    firstFrame = window.requestAnimationFrame(() => {
      forceLayoutCheck();
      secondFrame = window.requestAnimationFrame(forceLayoutCheck);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [controlsVisible]);

  useEffect(() => {
    let cancelled = false;
    liveProviderRef.current
      .refreshConfiguration()
      .then((config) => {
        if (cancelled) return;
        setLiveConfig(config);
        setLiveStatus((status) => ({ ...status, configured: config.configured }));
        setSelectedAsrProviderId((providerId) => coerceSelectedProvider(providerId, config, localWhisperSettings));
      })
      .catch((error) => {
        if (cancelled) return;
        setLiveStatus((status) => ({
          ...status,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unable to read live ASR configuration.'
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [localWhisperSettings]);

  useEffect(() => {
    let cancelled = false;
    localWhisperProviderRef.current
      .refreshStatus()
      .then((status) => {
        if (!cancelled) setLocalWhisperStatus(status);
      })
      .catch((error) => {
        if (cancelled) return;
        setLocalWhisperStatus((status) => ({
          ...status,
          status: 'error',
          modelPhase: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unable to read Local Whisper status.'
        }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const refreshLocalWhisperDiagnostics = () => {
      localWhisperProviderRef.current
        .refreshStatus()
        .then(setLocalWhisperStatus)
        .catch(() => undefined);
    };
    window.addEventListener('prompter-main-preload-error', refreshLocalWhisperDiagnostics);
    return () => window.removeEventListener('prompter-main-preload-error', refreshLocalWhisperDiagnostics);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setInputLevel((level) => Math.max(0, level - 0.08));
    }, 240);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveSession({
        projectTitle,
        approvedManuscript,
        manuscriptText,
        currentTokenIndex,
        currentSentenceIndex,
        currentParagraphIndex,
        displaySettings,
        followState,
        selectedAsrProviderId,
        localWhisperSettings,
        mockScript,
        debugVisible,
        developerMode
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    approvedManuscript,
    currentParagraphIndex,
    currentSentenceIndex,
    currentTokenIndex,
    debugVisible,
    developerMode,
    displaySettings,
    followState,
    manuscriptText,
    mockScript,
    projectTitle,
    selectedAsrProviderId,
    localWhisperSettings
  ]);

  const toggleFollow = useCallback(async () => {
    if (approvedManuscript && !isListening && !isMockPlaying) {
      try {
        const verified = await window.prompterApi?.readPrepApproved(approvedManuscript.projectId, approvedManuscript.approvedId);
        if (!verified || verified.textSha256 !== approvedManuscript.textSha256 || verified.text !== manuscriptText) throw new Error('Approved text identity no longer matches. Reselect the approval in Manuscript Prep.');
        setApprovalError(null);
      } catch (error) { setApprovalError(String(error)); return; }
    }
    if (followStateRef.current === 'manual') {
      await requestStartupVisibleAnchor();
      enterFollowing();
      return;
    }
    applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
  }, [applyCoordinatorState, enterFollowing, requestStartupVisibleAnchor, sessionCoordinator]);

  const togglePause = useCallback(async () => {
    if (followStateRef.current === 'paused') {
      await requestStartupVisibleAnchor();
      enterFollowing();
      return;
    }
    applyCoordinatorState(sessionCoordinator.setFollowState('paused'));
  }, [applyCoordinatorState, enterFollowing, requestStartupVisibleAnchor, sessionCoordinator]);

  const stepSentence = useCallback((direction: -1 | 1) => {
    const model = manuscriptRef.current;
    const target = clamp(currentSentenceIndex + direction, 0, Math.max(model.sentences.length - 1, 0));
    resetAlignmentContext();
    moveToToken(tokenIndexForSentence(model, target), 'manual');
  }, [currentSentenceIndex, moveToToken, resetAlignmentContext]);

  const stepParagraph = useCallback((direction: -1 | 1) => {
    const model = manuscriptRef.current;
    const target = clamp(currentParagraphIndex + direction, 0, Math.max(model.paragraphs.length - 1, 0));
    resetAlignmentContext();
    moveToToken(tokenIndexForParagraph(model, target), 'manual');
  }, [currentParagraphIndex, moveToToken, resetAlignmentContext]);

  const resync = useCallback(() => {
    applyCoordinatorState(sessionCoordinator.armResync());
  }, [applyCoordinatorState, sessionCoordinator]);

  const injectManual = useCallback(async () => {
    if (tabletModeRef.current) return;
    await manualProviderRef.current.start();
    setIsListening(true);
    manualProviderRef.current.pushText(manualTranscript);
    setManualTranscript('');
  }, [manualTranscript]);

  const playMock = useCallback(async () => {
    if (tabletModeRef.current) return;
    const lines = mockScript.split(/\r?\n/);
    const intervalMs = slowMockRef.current ? 2800 : 950;
    mockProviderRef.current.setScript(lines, intervalMs);
    setControlsVisible(false);
    await requestStartupVisibleAnchor();
    setIsMockPlaying(true);
    enterFollowing();
    await mockProviderRef.current.start();
  }, [enterFollowing, mockScript, requestStartupVisibleAnchor]);

  const stopMock = useCallback(async () => {
    await mockProviderRef.current.stop();
    setIsMockPlaying(false);
    applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
  }, [applyCoordinatorState, sessionCoordinator]);

  const startMicMonitor = useCallback(async () => {
    if (tabletModeRef.current) return;
    if (selectedAsrProviderRef.current !== 'local-whisper') return;
    try {
      await localWhisperProviderRef.current.startMicMonitoring();
    } catch {
      // Provider diagnostics already carry the user-facing microphone error.
    }
  }, []);

  const stopMicMonitor = useCallback(async () => {
    await localWhisperProviderRef.current.stopMicMonitoring();
  }, []);

  const stopDesktopSourcesForTabletMode = useCallback(async () => {
    clearMicStartupGrace();
    const stops: Promise<unknown>[] = [];
    if (isListening) stops.push(manualProviderRef.current.stop());
    if (isMockPlaying) stops.push(mockProviderRef.current.stop());
    if (liveStatus.listening) stops.push(liveProviderRef.current.stop());
    if (localWhisperStatus.listening) stops.push(localWhisperProviderRef.current.stop());
    await Promise.allSettled(stops);
    setIsListening(false);
    setIsMockPlaying(false);
  }, [clearMicStartupGrace, isListening, isMockPlaying, liveStatus.listening, localWhisperStatus.listening]);

  useEffect(() => {
    const unsubscribeMode = window.prompterApi?.onTabletMode((status) => {
      tabletModeRef.current = status.mode === 'tablet';
      setTabletModeStatus(status);
      if (status.mode === 'tablet') void stopDesktopSourcesForTabletMode();
    });
    const unsubscribeState = window.prompterApi?.onServerSessionState((update) => {
      if (update.origin !== 'tablet') return;
      if (rendererProjectionForTabletUpdate(tabletModeRef.current, update.movementSuppressedOnDesktop) === 'diagnostics-only') {
        applyCoordinatorDiagnostics(update.state);
      } else {
        applyCoordinatorState(sessionCoordinator.adoptAuthoritativeState(update.state));
      }
    });
    return () => {
      unsubscribeMode?.();
      unsubscribeState?.();
    };
  }, [applyCoordinatorDiagnostics, applyCoordinatorState, sessionCoordinator, stopDesktopSourcesForTabletMode]);

  const toggleListening = useCallback(async () => {
    if (tabletModeRef.current) return;
    if (selectedAsrProviderRef.current === 'mock') {
      if (isMockPlaying) {
        await stopMock();
      } else {
        await playMock();
      }
      return;
    }

    if (selectedAsrProviderRef.current === 'openai-realtime') {
      if (!liveConfig.enabled) {
        setSelectedAsrProviderId('manual');
        applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
        return;
      }
      if (liveStatus.listening) {
        await liveProviderRef.current.stop();
        applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
      } else {
        try {
          await liveProviderRef.current.start();
          if (displaySettings.autoHideControlsOnStart) {
            setControlsVisible(false);
          }
          await requestStartupVisibleAnchor();
          enterFollowing();
        } catch {
          // Provider status already carries the sanitized error; manual and mock remain usable.
        }
      }
      return;
    }

    if (selectedAsrProviderRef.current === 'local-whisper') {
      if (localWhisperStatus.listening) {
        clearMicStartupGrace();
        await localWhisperProviderRef.current.stop();
        applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
      } else {
        if (!localWhisperStatus.bridge.localWhisperBridgeAvailable) {
          await localWhisperProviderRef.current.refreshStatus().catch(() => undefined);
          if (!localWhisperProviderRef.current.getConnectionStatus().bridge.localWhisperBridgeAvailable) {
            return;
          }
        }
        activeStartAttemptRef.current = {
          providerId: 'local-whisper',
          source: 'Local Whisper provider startup',
          lastIssue: null
        };
        beginMicStartupGrace();
        try {
          await localWhisperProviderRef.current.start();
          if (localWhisperProviderRef.current.getStatus() !== 'listening') {
            clearMicStartupGrace();
            return;
          }
          settleMicStartupGrace();
          const attempt = activeStartAttemptRef.current;
          if (attempt?.providerId === 'local-whisper') {
            if (attempt.lastIssue) {
              setLastStartDiagnostic({
                ...attempt.lastIssue,
                blocking: false,
                recovered: true
              });
            } else {
              setLastStartDiagnostic((previous) =>
                previous?.source === attempt.source && previous.blocking && !previous.recovered
                  ? { ...previous, blocking: false, recovered: true }
                  : previous
              );
            }
          }
          if (displaySettings.autoHideControlsOnStart) {
            setControlsVisible(false);
          }
          await requestStartupVisibleAnchor();
          enterFollowing();
        } catch (error) {
          clearMicStartupGrace();
          const attempt = activeStartAttemptRef.current;
          const message = error instanceof Error ? error.message : 'Local Whisper failed to start.';
          if (!isBenignStartDiagnosticMessage(message)) {
            setLastStartDiagnostic({
              timestampMs: Date.now(),
              source: attempt?.source ?? 'Local Whisper provider startup',
              level: 'error',
              message,
              blocking: true,
              recovered: false
            });
          }
          // Provider status already carries the error; Manual and Mock remain usable.
        } finally {
          if (activeStartAttemptRef.current?.providerId === 'local-whisper') {
            activeStartAttemptRef.current = null;
          }
        }
      }
      return;
    }

    if (isListening) {
      await manualProviderRef.current.stop();
      setIsListening(false);
      applyCoordinatorState(sessionCoordinator.setFollowState('manual'));
    } else {
      setControlsVisible(false);
      await requestStartupVisibleAnchor();
      await manualProviderRef.current.start();
      setIsListening(true);
      enterFollowing();
    }
  }, [
    applyCoordinatorState,
    isListening,
    isMockPlaying,
    liveConfig.enabled,
    liveStatus.listening,
    beginMicStartupGrace,
    clearMicStartupGrace,
    enterFollowing,
    localWhisperStatus.bridge.localWhisperBridgeAvailable,
    localWhisperStatus.listening,
    playMock,
    requestStartupVisibleAnchor,
    sessionCoordinator,
    settleMicStartupGrace,
    stopMock,
    approvedManuscript,
    manuscriptText
  ]);

  const importTxt = useCallback(async () => {
    const openManuscriptFile =
      window.prompterApi?.openManuscriptFile ?? window.prompterApi?.openTextFile;
    if (openManuscriptFile) {
      try {
        const result = await openManuscriptFile();
        if (!result) return;
        setManuscriptImportError(null);
        setProjectTitle(result.name.replace(/\.[^.]+$/, '') || result.name);
        setApprovedManuscript(undefined);
      setManuscriptText(cleanupImportedManuscriptText(result.text, {
          addExtraSpacingBetweenLines: displaySettings.addExtraSpacingOnImport
        }));
        resetAlignmentContext();
        moveToToken(0, 'manual');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setManuscriptImportError(
          message.includes('No selectable text found in this PDF')
            ? 'No selectable text found in this PDF. Try copy/paste or OCR first.'
            : message.replace(/^Error invoking remote method '[^']+':\s*/i, '') ||
                'Could not import the selected manuscript.'
        );
      }
      return;
    }

    fileInputRef.current?.click();
  }, [displaySettings.addExtraSpacingOnImport, moveToToken, resetAlignmentContext]);

  const localFileSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (/\.(docx|pdf)$/i.test(file.name)) {
      setManuscriptImportError('DOCX and PDF import require the Electron desktop app.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setManuscriptImportError(null);
      setProjectTitle(file.name.replace(/\.[^.]+$/, '') || file.name);
      setApprovedManuscript(undefined);
      setManuscriptText(cleanupImportedManuscriptText(String(reader.result ?? ''), {
        addExtraSpacingBetweenLines: displaySettings.addExtraSpacingOnImport
      }));
      resetAlignmentContext();
      moveToToken(0, 'manual');
      event.target.value = '';
    };
    reader.onerror = () => {
      setManuscriptImportError('Could not read the selected manuscript file.');
      event.target.value = '';
    };
    reader.readAsText(file);
  }, [displaySettings.addExtraSpacingOnImport, moveToToken, resetAlignmentContext]);

  const searchJump = useCallback(() => {
    const model = manuscriptRef.current;
    const found = searchManuscript(model, searchQuery, currentTokenRef.current + 1);
    if (found !== null) {
      resetAlignmentContext();
      moveToToken(found, 'manual');
      applyCoordinatorState(sessionCoordinator.setManualAlignment({
        ...emptyAlignment(model, found),
        confidence: 1,
        matchedText: searchQuery,
        reason: 'Manual search jump.'
      }));
    }
  }, [applyCoordinatorState, moveToToken, resetAlignmentContext, searchQuery, sessionCoordinator]);

  const toggleFullScreen = useCallback(() => {
    void window.prompterApi?.toggleFullScreen();
  }, []);

  const toggleAlwaysOnTop = useCallback(() => {
    void window.prompterApi?.toggleAlwaysOnTop();
  }, []);

  const prepareTablet = useCallback(() => {
    void window.prompterApi?.prepareTablet()
      .then(setTabletStatus)
      .catch(() => undefined);
  }, []);

  const setTabletUsbMode = useCallback((mode: UsbTransportMode) => {
    void window.prompterApi?.setTabletUsbMode(mode)
      .then((usbTransport) => {
        if (usbTransport) setTabletStatus((current) => current ? { ...current, usbTransport } : current);
      })
      .catch(() => undefined);
  }, []);

  const selectTabletUsbDevice = useCallback((serial: string | null) => {
    void window.prompterApi?.selectTabletUsbDevice(serial)
      .then((usbTransport) => {
        if (usbTransport) setTabletStatus((current) => current ? { ...current, usbTransport } : current);
      })
      .catch(() => undefined);
  }, []);

  const retryTabletUsb = useCallback(() => {
    void window.prompterApi?.retryTabletUsb()
      .then((usbTransport) => {
        if (usbTransport) setTabletStatus((current) => current ? { ...current, usbTransport } : current);
      })
      .catch(() => undefined);
  }, []);

  const quitPrompter = useCallback(() => {
    void window.prompterApi?.quitApp();
  }, []);

  const selectAsrProvider = useCallback((providerId: AsrProviderId) => {
    if (tabletModeRef.current) return;
    clearMicStartupGrace();
    activeStartAttemptRef.current = null;
    setSelectedAsrProviderId(coerceSelectedProvider(providerId, liveConfig, localWhisperSettings));
  }, [clearMicStartupGrace, liveConfig, localWhisperSettings]);

  const localWhisperSettingsDirty = !localWhisperSettingsEqual(
    localWhisperSettings,
    localWhisperDraftSettings
  );

  const applyLocalWhisperSettings = useCallback(() => {
    setLocalWhisperSettings(localWhisperDraftSettings);
  }, [localWhisperDraftSettings]);

  const restartLocalWhisper = useCallback(async () => {
    const nextSettings = localWhisperDraftSettings;
    if (!localWhisperStatus.listening) {
      setLocalWhisperSettings(nextSettings);
      return;
    }

    try {
      await localWhisperProviderRef.current.stop();
      setLocalWhisperSettings(nextSettings);
      localWhisperProviderRef.current.setSettings(nextSettings);
      await localWhisperProviderRef.current.start();
      setControlsVisible(false);
      await requestStartupVisibleAnchor();
      enterFollowing();
    } catch {
      // Provider status already carries the user-facing restart error.
    }
  }, [enterFollowing, localWhisperDraftSettings, localWhisperStatus.listening, requestStartupVisibleAnchor]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const editable = isEditableTarget(event.target);
      const key = event.key.toLowerCase();

      if (event.key === 'F11') {
        event.preventDefault();
        toggleFullScreen();
        return;
      }

      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        setDebugVisible((visible) => !visible);
        return;
      }

      if (event.ctrlKey && event.shiftKey && key === 'd') {
        event.preventDefault();
        setDeveloperMode((enabled) => !enabled);
        return;
      }

      if (event.ctrlKey && event.altKey && key === 'c') {
        event.preventDefault();
        setControlsVisible((visible) => !visible);
        return;
      }

      if (event.ctrlKey && !event.altKey && key === 'f') {
        event.preventDefault();
        document.getElementById('manuscript-search')?.focus();
        return;
      }

      if (editable) {
        return;
      }

      if (event.ctrlKey && event.altKey && key === 'l') {
        event.preventDefault();
        void toggleListening();
      } else if (event.ctrlKey && event.altKey && key === 'f') {
        event.preventDefault();
        toggleFollow();
      } else if (event.ctrlKey && event.altKey && key === 'p') {
        event.preventDefault();
        togglePause();
      } else if (event.ctrlKey && event.altKey && key === 'r') {
        event.preventDefault();
        resync();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        stepSentence(-1);
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        stepSentence(1);
      } else if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        stepParagraph(-1);
      } else if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        stepParagraph(1);
      } else if (event.ctrlKey && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setDisplaySettings((settings) => ({
          ...settings,
          fontSizePx: clamp(settings.fontSizePx + 2, 22, 78)
        }));
      } else if (event.ctrlKey && event.key === '-') {
        event.preventDefault();
        setDisplaySettings((settings) => ({
          ...settings,
          fontSizePx: clamp(settings.fontSizePx - 2, 22, 78)
        }));
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    resync,
    stepParagraph,
    stepSentence,
    toggleFollow,
    toggleFullScreen,
    toggleListening,
    togglePause
  ]);

  const selectedProviderListening =
    selectedAsrProviderId === 'openai-realtime'
      ? liveStatus.listening
      : selectedAsrProviderId === 'mock'
        ? isMockPlaying
        : selectedAsrProviderId === 'local-whisper'
          ? localWhisperStatus.listening
          : isListening;
  const tabletMode = tabletModeStatus.mode === 'tablet';
  const selectedProviderStarting =
    selectedAsrProviderId === 'openai-realtime'
      ? liveStatus.status === 'starting'
      : selectedAsrProviderId === 'local-whisper'
        ? localWhisperStatus.status === 'starting' ||
          localWhisperStatus.modelPhase === 'starting' ||
          localWhisperStatus.modelPhase === 'process-started' ||
          localWhisperStatus.modelPhase === 'model-loading'
        : false;
  const selectedInputLevel =
    selectedAsrProviderId === 'local-whisper'
      ? localWhisperStatus.mic.inputLevel
      : inputLevel;
  const providerOptions = getAsrProviderOptions(liveConfig, localWhisperSettings);
  const selectedProviderLabel =
    providerOptions.find((option) => option.id === selectedAsrProviderId)?.label ?? 'Manual';
  const localMicState = localWhisperStatus.mic.captureState;
  const localMicActive =
    localMicState === 'stream-active' ||
    localMicState === 'pcm-capturing' ||
    localMicState === 'chunk-sent' ||
    localMicState === 'chunk-returned' ||
    localMicState === 'media-recorder-recording';
  const selectedProviderExpectsMic =
    selectedAsrProviderId === 'local-whisper' || selectedAsrProviderId === 'openai-realtime';
  const selectedProviderMicActive =
    selectedAsrProviderId === 'local-whisper'
      ? localMicActive
      : selectedAsrProviderId === 'openai-realtime'
        ? liveStatus.connected || liveStatus.listening
        : false;
  const localQueueLagging =
    selectedAsrProviderId === 'local-whisper' &&
    (
      localWhisperStatus.chunk.lastRealtimeFactor > 1.2 ||
      localWhisperStatus.chunk.avgRealtimeFactor > 1.2 ||
      localWhisperStatus.chunk.estimatedQueueLatencyMs > 4000 ||
      localWhisperStatus.chunk.queueLength >= Math.max(1, localWhisperStatus.chunk.maxQueueLength)
    );
  const selectedProviderError =
    selectedAsrProviderId === 'openai-realtime'
      ? liveStatus.errorMessage
      : selectedAsrProviderId === 'local-whisper'
        ? localWhisperStatus.errorMessage ??
          localWhisperStatus.mic.errorMessage ??
          (!localWhisperStatus.bridge.localWhisperBridgeAvailable
            ? localWhisperStatus.bridge.errorMessage
            : null)
        : null;
  const selectedProviderWarning =
    selectedAsrProviderId === 'local-whisper'
      ? localWhisperStatus.chunk.warningMessage
      : null;
  const transcriptPipelineState = selectedAsrProviderId === 'local-whisper' && selectedProviderListening
    ? deriveTranscriptPipelineState(localWhisperStatus.chunk, followState, Date.now())
    : 'normal';
  const narrationStatus = deriveNarrationStatus({
    isRunning: selectedProviderListening,
    isStarting: selectedProviderStarting,
    followState,
    confidence: alignment.confidence,
    expectsMic: selectedProviderExpectsMic,
    micActive: selectedProviderMicActive,
    micStartupGraceActive: selectedProviderStarting || micStartupGraceActive,
    inputLevel: selectedInputLevel,
    isLagging: localQueueLagging,
    errorMessage: selectedProviderError,
    warningMessage: selectedProviderWarning,
    pipelineState: transcriptPipelineState
  });
  const publishLocalWhisperTelemetry = useCallback(() => {
    const recordTelemetry = window.prompterApi?.recordLocalWhisperTelemetry;
    if (!recordTelemetry) return;
    const aggregate = localWhisperTelemetryRef.current.drain();
    if (aggregate) void recordTelemetry(aggregate).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (selectedAsrProviderId !== 'local-whisper') return;
    localWhisperTelemetryRef.current.recordNarratorStatus(narrationStatus.label);
  }, [narrationStatus.label, selectedAsrProviderId]);

  useEffect(() => {
    if (selectedAsrProviderId !== 'local-whisper' || !selectedProviderListening) return;
    const timer = window.setInterval(publishLocalWhisperTelemetry, 60_000);
    return () => {
      window.clearInterval(timer);
      publishLocalWhisperTelemetry();
      localWhisperTelemetryRef.current.resetLifecycleCorrelations();
    };
  }, [publishLocalWhisperTelemetry, selectedAsrProviderId, selectedProviderListening, sessionResetId]);

  const startStopDisabled = tabletMode || (
    selectedAsrProviderId === 'local-whisper' &&
    !selectedProviderListening &&
    !localWhisperStatus.bridge.localWhisperBridgeAvailable);

  return (
    <div className={`app-shell ${controlsVisible ? '' : 'controls-hidden'}`}>
      {tabletMode && (
        <div className="tablet-mode-banner">
          Tablet control — {tabletModeStatus.deviceName ?? 'Android tablet'} is running narration
        </div>
      )}
      {approvalError && <p role="alert">{approvalError}</p>}
      {manuscriptPrepOpen && <ManuscriptPrepWorkspace onClose={() => setManuscriptPrepOpen(false)} onSelect={(value) => {
        if (isListening || isMockPlaying || localWhisperStatus.listening || liveStatus.listening) { setApprovalError('Stop following before changing the approved manuscript.'); return; }
        setApprovedManuscript({ projectId: value.projectId, approvedId: value.approvedId, textSha256: value.textSha256 });
        setManuscriptText(value.text); setProjectTitle(value.sourceDisplayName); setApprovalError(null);
        resetAlignmentContext(); moveToToken(0, 'manual'); setManuscriptPrepOpen(false);
      }} />}
      <ControlPanel
        projectTitle={projectTitle}
        onProjectTitleChange={setProjectTitle}
        manuscriptText={manuscriptText}
        onManuscriptTextChange={(text) => {
          setManuscriptImportError(null);
          setApprovedManuscript(undefined);
          setManuscriptText(text);
        }}
        onImportTxt={importTxt}
        manuscriptImportError={manuscriptImportError}
        onLocalFileSelected={localFileSelected}
        fileInputRef={fileInputRef}
        model={manuscript}
        selectedAsrProviderId={selectedAsrProviderId}
        onSelectedAsrProviderChange={selectAsrProvider}
        liveConfig={liveConfig}
        liveStatus={liveStatus}
        localWhisperSettings={localWhisperDraftSettings}
        appliedLocalWhisperSettings={localWhisperSettings}
        onLocalWhisperSettingsChange={setLocalWhisperDraftSettings}
        localWhisperSettingsDirty={localWhisperSettingsDirty}
        onApplyLocalWhisperSettings={applyLocalWhisperSettings}
        onRestartLocalWhisper={restartLocalWhisper}
        localWhisperStatus={localWhisperStatus}
        narrationStatus={narrationStatus}
        developerMode={developerMode}
        onToggleDeveloperMode={() => setDeveloperMode((enabled) => !enabled)}
        isListening={selectedProviderListening}
        isMockPlaying={isMockPlaying}
        inputLevel={selectedInputLevel}
        followState={followState}
        confidence={alignment.confidence}
        currentSentenceIndex={currentSentenceIndex}
        currentParagraphIndex={currentParagraphIndex}
        onStartStop={toggleListening}
        onStartMicMonitor={startMicMonitor}
        onStopMicMonitor={stopMicMonitor}
        onToggleFollow={toggleFollow}
        onTogglePause={togglePause}
        onStepSentence={stepSentence}
        onStepParagraph={stepParagraph}
        onResync={resync}
        manualTranscript={manualTranscript}
        onManualTranscriptChange={setManualTranscript}
        onInjectManual={injectManual}
        mockScript={mockScript}
        onMockScriptChange={setMockScript}
        onPlayMock={playMock}
        onStopMock={stopMock}
        slowMock={slowMock}
        onSlowMockChange={setSlowMock}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearchJump={searchJump}
        settings={displaySettings}
        onSettingsChange={setDisplaySettings}
        onTestSmoothScroll={requestSmoothScrollTest}
        onResetTestScroll={requestResetScrollTest}
        onToggleDebug={() => setDebugVisible((visible) => !visible)}
        onToggleFullScreen={toggleFullScreen}
        onToggleAlwaysOnTop={toggleAlwaysOnTop}
        debugVisible={debugVisible}
        deltas={deltas}
        transcriptBuffer={transcriptBuffer}
        alignment={alignment}
        currentTokenIndex={currentTokenIndex}
        alignmentBufferDebug={alignmentBufferDebug}
        traceLog={traceLog}
        assistStatus={assistStatus}
        anchorDebug={anchorDebug}
        scrollAnimationStatus={scrollAnimationStatus}
        movementDecision={movementDecision}
        movementDecisionHistory={movementDecisionHistory}
        lastStartDiagnostic={lastStartDiagnostic}
        tabletStatus={tabletStatus}
        onPrepareTablet={prepareTablet}
        onSetTabletUsbMode={setTabletUsbMode}
        onSelectTabletUsbDevice={selectTabletUsbDevice}
        onRetryTabletUsb={retryTabletUsb}
        onQuitPrompter={quitPrompter}
        providerControlsDisabled={tabletMode}
      />
      <div className="prompter-stage" ref={prompterStageRef}>
        <NarrationBar
          status={narrationStatus}
          providerLabel={selectedProviderLabel}
          isRunning={selectedProviderListening}
          inputLevel={selectedInputLevel}
          controlsVisible={controlsVisible}
          startStopDisabled={startStopDisabled}
          onStartStop={toggleListening}
          isPaused={followState === 'paused'}
          projectTitle={projectTitle}
          manuscriptIdentity={approvedManuscript
            ? `Approved · ${approvedManuscript.textSha256.slice(0, 12)}`
            : 'Unapproved text · review in Manuscript Prep'}
          onTogglePause={togglePause}
          onOpenManuscriptPrep={() => setManuscriptPrepOpen(true)}
          onToggleControls={() => setControlsVisible((visible) => !visible)}
        />
        <div className="reader-content">
          <PrompterView
            model={manuscript}
            currentSentenceIndex={currentSentenceIndex}
            currentTokenIndex={currentTokenIndex}
            followState={tabletMode ? 'paused' : followState}
            confidence={alignment.confidence}
            settings={displaySettings}
            layoutMode={controlsVisible ? 'with-controls' : 'prompter-only'}
            assistScrollLagging={localQueueLagging}
            manualScrollTrackingEnabled={!tabletMode}
            visibleReacquireActive={Boolean(manualReacquireAnchor)}
            visibleReacquireSource={manualReacquireAnchor?.source}
            startupVisibleAnchorRequestId={startupVisibleAnchorRequestId}
            scrollTestRequest={scrollTestRequest}
            onTraceScroll={onTraceScroll}
            onAssistStatus={onAssistStatus}
            onScrollAnimationStatus={onScrollAnimationStatus}
            onStartupVisibleAnchor={onStartupVisibleAnchor}
            onManualScroll={onManualScroll}
            onAnchorDebug={onAnchorDebug}
          />
        </div>
        {!controlsVisible && (
          <nav className="reader-footer" aria-label="Reading recovery controls">
            <div className="reader-footer-group">
              <button type="button" aria-label="Previous sentence" onClick={() => stepSentence(-1)}>Previous</button>
              <button type="button" className="reader-resync" onClick={resync}>Resync</button>
              <button type="button" aria-label="Next sentence" onClick={() => stepSentence(1)}>Next</button>
            </div>
            <div className="reader-footer-group reader-text-size" aria-label="Reading text size">
              <span>Text size</span>
              <button type="button" aria-label="Decrease reading text size" disabled={displaySettings.fontSizePx <= 24} onClick={() => setDisplaySettings((s) => ({ ...s, fontSizePx: Math.max(24, s.fontSizePx - 2) }))}>A−</button>
              <button type="button" aria-label="Increase reading text size" disabled={displaySettings.fontSizePx >= 42} onClick={() => setDisplaySettings((s) => ({ ...s, fontSizePx: Math.min(42, s.fontSizePx + 2) }))}>A+</button>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
