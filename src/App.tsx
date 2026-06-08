import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ManualAsrProvider } from './asr/ManualAsrProvider';
import { MockAsrProvider } from './asr/MockAsrProvider';
import { DEFAULT_LOCAL_WHISPER_STATUS, LocalWhisperAsrProvider } from './asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from './asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions } from './asr/providerRegistry';
import { ControlPanel } from './components/ControlPanel';
import { NarrationBar } from './components/NarrationBar';
import { PrompterView } from './components/PrompterView';
import { alignTranscript } from './domain/alignment';
import {
  alignmentBufferTokens,
  createAlignmentBufferState,
  evaluateProvisionalAlignmentBuffer
} from './domain/alignmentBuffer';
import {
  buildManuscript,
  findParagraphIndexForSentence,
  findSentenceIndexForToken,
  searchManuscript,
  tokenIndexForParagraph,
  tokenIndexForSentence
} from './domain/manuscript';
import { shouldRecoverControlsFromHiddenLayout } from './domain/layoutRecovery';
import { deriveNarrationStatus } from './domain/narrationStatus';
import { HIGH_CONFIDENCE, stateFromAlignment } from './domain/scrollModel';
import { transcriptToTokens } from './domain/normalize';
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
  DEFAULT_LOCAL_WHISPER_SETTINGS,
  DEFAULT_MOCK_SCRIPT,
  resolveInitialDisplaySettings,
  SAMPLE_MANUSCRIPT
} from './state/appStore';
import { loadSession, saveSession } from './state/projectStore';
import { isEditableTarget } from './shortcuts/shortcuts';

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
  configured: false,
  providerId: 'openai-realtime',
  model: 'gpt-4o-transcribe',
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

const EMPTY_ALIGNMENT_BUFFER_DEBUG: AlignmentBufferDebug = {
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

const DISPLAY_SETTINGS_MIGRATION_KEY = 'narration-prompter.display-settings-v3-reading-band-migrated';

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
  const [projectTitle, setProjectTitle] = useState(stored?.projectTitle ?? 'Narration Session');
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
  const [selectedAsrProviderId, setSelectedAsrProviderId] = useState<AsrProviderId>(
    (stored?.selectedAsrProviderId as AsrProviderId | undefined) ?? 'manual'
  );
  const [isListening, setIsListening] = useState(false);
  const [isMockPlaying, setIsMockPlaying] = useState(false);
  const [debugVisible, setDebugVisible] = useState(stored?.debugVisible ?? true);
  const [controlsVisible, setControlsVisible] = useState(() => {
    try {
      return localStorage.getItem('narration-prompter.controls-visible') !== 'false';
    } catch {
      return true;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [transcriptBuffer, setTranscriptBuffer] = useState<string[]>([]);
  const [deltas, setDeltas] = useState<TranscriptDelta[]>([]);
  const [traceLog, setTraceLog] = useState<string[]>([]);
  const [slowMock, setSlowMock] = useState(false);
  const [assistStatus, setAssistStatus] = useState<AssistStatusInfo | null>(null);
  const [anchorDebug, setAnchorDebug] = useState(null);
  const [scrollTestRequest, setScrollTestRequest] = useState<ScrollTestRequest | null>(null);
  const [scrollAnimationStatus, setScrollAnimationStatus] = useState<ScrollAnimationStatusInfo | null>(null);
  const [alignmentBufferDebug, setAlignmentBufferDebug] = useState<AlignmentBufferDebug>(
    EMPTY_ALIGNMENT_BUFFER_DEBUG
  );
  const [inputLevel, setInputLevel] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const prompterStageRef = useRef<HTMLDivElement | null>(null);
  const manualProviderRef = useRef(new ManualAsrProvider());
  const mockProviderRef = useRef(new MockAsrProvider());
  const liveProviderRef = useRef(new OpenAiRealtimeAsrProvider());
  const localWhisperProviderRef = useRef(
    new LocalWhisperAsrProvider(initialLocalWhisperSettings)
  );
  const resyncArmedRef = useRef(false);
  const lowConfidenceCountRef = useRef(0);
  const localAlignmentBufferRef = useRef(createAlignmentBufferState());
  const scrollTestIdRef = useRef(0);
  const manuscript = useMemo(() => buildManuscript(manuscriptText), [manuscriptText]);
  const manuscriptRef = useRef(manuscript);
  const currentTokenRef = useRef(currentTokenIndex);
  const followStateRef = useRef(followState);
  const [alignment, setAlignment] = useState<AlignmentResult>(() => emptyAlignment(manuscript, currentTokenIndex));
  const selectedAsrProviderRef = useRef(selectedAsrProviderId);
  const slowMockRef = useRef(false);
  const displaySettingsRef = useRef<DisplaySettings | null>(null);

  useEffect(() => {
    if (shouldRunDisplaySettingsMigration) {
      markDisplaySettingsMigrationRun();
    }
  }, [shouldRunDisplaySettingsMigration]);

  useEffect(() => {
    displaySettingsRef.current = displaySettings;
  }, [displaySettings]);

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
    localAlignmentBufferRef.current = createAlignmentBufferState();
    setAlignmentBufferDebug(EMPTY_ALIGNMENT_BUFFER_DEBUG);
  }, [manuscript]);

  useEffect(() => {
    currentTokenRef.current = currentTokenIndex;
  }, [currentTokenIndex]);

  useEffect(() => {
    followStateRef.current = followState;
  }, [followState]);

  useEffect(() => {
    selectedAsrProviderRef.current = selectedAsrProviderId;
  }, [selectedAsrProviderId]);

  const moveToToken = useCallback((tokenIndex: number, nextState: FollowState = 'manual') => {
    const model = manuscriptRef.current;
    const clamped = clamp(tokenIndex, 0, Math.max(model.tokens.length - 1, 0));
    const sentenceIndex = findSentenceIndexForToken(model, clamped);
    currentTokenRef.current = clamped;
    setCurrentTokenIndex(clamped);
    setCurrentSentenceIndex(sentenceIndex);
    setCurrentParagraphIndex(findParagraphIndexForSentence(model, sentenceIndex));
    setFollowState(nextState);
  }, []);

  const appendTrace = useCallback((entry: string) => {
    setTraceLog((prev) => [...prev.slice(-39), entry]);
  }, []);

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

  const resetAlignmentContext = useCallback(() => {
    localAlignmentBufferRef.current = createAlignmentBufferState();
    setTranscriptBuffer([]);
    setAlignmentBufferDebug(EMPTY_ALIGNMENT_BUFFER_DEBUG);
  }, []);

  const onTraceScroll = useCallback((info: { sentenceIndex: number; didScroll: boolean; reason: string }) => {
    const r = info.reason || '';
    if (r.includes('assist cruise')) {
      const ds = displaySettingsRef.current;
      const extra = ds ? ` | assist continuous=${ds.continuousAssistScroll ? 1 : 0} speed=${ds.assistScrollSpeed} feel=${ds.assistCorrectionFeel}` : '';
      appendTrace(`scroll s${info.sentenceIndex} ${info.didScroll ? 'SCROLLED' : 'NO-SCROLL'} (${r})${extra}`);
    } else {
      appendTrace(`scroll s${info.sentenceIndex} ${info.didScroll ? 'SCROLLED' : 'NO-SCROLL'} (${info.reason})`);
    }
  }, [appendTrace]);

  const onAssistStatus = useCallback((info: AssistStatusInfo) => {
    setAssistStatus(info);
    // also surface key changes in trace for diagnostics (but UI status is the primary per req)
    if (info.state && info.state !== 'OFF') {
      appendTrace(`assist status: ${info.state}${info.cruiseVelocityPxPerSec != null ? ` vel=${Math.round(info.cruiseVelocityPxPerSec)}px/s` : ''}${info.estimatedPaceLinesPerMin != null ? ` pace=${info.estimatedPaceLinesPerMin}lpm` : ''}`);
    }
  }, [appendTrace]);

  const onAnchorDebug = useCallback((info: any) => {
    setAnchorDebug(info);
  }, []);

  const onScrollAnimationStatus = useCallback((info: ScrollAnimationStatusInfo) => {
    setScrollAnimationStatus(info);
  }, []);

  // Trace assist param changes (enabled/speed/feel) when user adjusts Display controls. Runs after appendTrace exists.
  useEffect(() => {
    appendTrace(`assist settings: continuous=${displaySettings.continuousAssistScroll ? 1 : 0} speed=${displaySettings.assistScrollSpeed} feel=${displaySettings.assistCorrectionFeel}`);
  }, [displaySettings.continuousAssistScroll, displaySettings.assistScrollSpeed, displaySettings.assistCorrectionFeel, appendTrace]);

  const processDelta = useCallback((delta: TranscriptDelta) => {
    const raw = delta.text;
    appendTrace(`recv ${delta.source}: raw="${raw}"`);
    setDeltas((previous) => [...previous.slice(-24), delta]);
    const words = transcriptToTokens(delta.text);
    appendTrace(`norm tokens: [${words.join(' ')}]`);
    setInputLevel(delta.text.trim() ? clamp(0.25 + words.length / 10, 0.25, 1) : 0);

    if (words.length === 0) {
      appendTrace('empty transcript -> holding');
      setAlignmentBufferDebug({
        ...EMPTY_ALIGNMENT_BUFFER_DEBUG,
        source: delta.source,
        rawTranscript: raw,
        moveDecision: 'held empty transcript',
        retentionDecision: 'discarded',
        retentionReason: 'empty transcript'
      });
      setFollowState((previous) => (previous === 'manual' ? 'manual' : 'holding'));
      return;
    }

    if (delta.source === 'local-whisper') {
      const model = manuscriptRef.current;
      const previousToken = currentTokenRef.current;
      const wasResyncing = resyncArmedRef.current;
      const decision = evaluateProvisionalAlignmentBuffer(
        model,
        localAlignmentBufferRef.current,
        words,
        previousToken,
        {
          widenWindow: wasResyncing || followStateRef.current === 'lost'
        }
      );
      localAlignmentBufferRef.current = decision.state;
      resyncArmedRef.current = false;
      setAlignment(decision.result);
      setTranscriptBuffer(alignmentBufferTokens(decision.state));

      let moveToTokenCalled = false;
      let moveDecision = 'held';
      appendTrace(
        `local eval buffer=[${decision.evaluationTokens.join(' ')}] provisional=[${decision.state.provisionalTokens.join(' ')}]`
      );
      appendTrace(
        `align matched="${decision.result.matchedText}" conf=${decision.result.confidence.toFixed(2)} deltaConf=${decision.deltaResult.confidence.toFixed(2)} | ${decision.result.reason}`
      );
      appendTrace(
        `context: ${decision.retainedDelta ? 'retained' : 'discarded'} (${decision.retentionReason}) retained=[${decision.retainedTokens.join(' ')}]`
      );

      if (followStateRef.current === 'manual' || followStateRef.current === 'paused') {
        moveDecision = 'manual/paused: no follow update';
        appendTrace('manual/paused: moveToToken not called');
      } else if (decision.moveRecommended && decision.result.confidence >= HIGH_CONFIDENCE) {
        lowConfidenceCountRef.current = 0;
        const nextState = stateFromAlignment(decision.result, previousToken, wasResyncing, 0);
        moveToToken(decision.result.tokenIndex, nextState);
        moveToTokenCalled = true;
        moveDecision = `moved to token ${decision.result.tokenIndex} state=${nextState}`;
        appendTrace(`moveToToken called: YES s${decision.result.sentenceIndex} state=${nextState}`);
      } else {
        lowConfidenceCountRef.current += 1;
        const heldHighConfidenceStaleContext =
          decision.result.confidence >= HIGH_CONFIDENCE && !decision.moveRecommended;
        const nextState = heldHighConfidenceStaleContext
          ? 'holding'
          : stateFromAlignment(
              decision.result,
              previousToken,
              wasResyncing,
              lowConfidenceCountRef.current
            );
        setFollowState(nextState);
        moveDecision = heldHighConfidenceStaleContext
          ? 'held: current delta did not contribute a manuscript anchor'
          : `held state=${nextState} confidence below threshold`;
        appendTrace(
          heldHighConfidenceStaleContext
            ? `moveToToken called: NO state=${nextState} (stale context)`
            : `moveToToken called: NO state=${nextState} (low-conf)`
        );
      }

      setAlignmentBufferDebug({
        source: delta.source,
        rawTranscript: raw,
        normalizedTokens: words,
        retainedTokens: decision.retainedTokens,
        rollingBufferTokens: decision.state.committedTokens,
        provisionalBufferTokens: decision.state.provisionalTokens,
        evaluationBufferTokens: decision.evaluationTokens,
        matchedText: decision.result.matchedText,
        confidence: decision.result.confidence,
        moveDecision,
        moveToTokenCalled,
        retentionDecision: decision.retainedDelta ? 'retained' : 'discarded',
        retentionReason: decision.retentionReason
      });
      return;
    }

    setTranscriptBuffer((previous) => {
      const next = [...previous, ...words].slice(-28);
      const model = manuscriptRef.current;
      const previousToken = currentTokenRef.current;
      const wasResyncing = resyncArmedRef.current;
      const result = alignTranscript(model, next, previousToken, {
        widenWindow: wasResyncing || followStateRef.current === 'lost'
      });

      setAlignment(result);
      resyncArmedRef.current = false;
      appendTrace(`align matched="${result.matchedText}" conf=${result.confidence.toFixed(2)} s${result.sentenceIndex} p${result.paragraphIndex} t${result.tokenIndex} | ${result.reason}`);

      if (followStateRef.current === 'manual' || followStateRef.current === 'paused') {
        appendTrace('manual/paused: no follow update');
        setAlignmentBufferDebug({
          source: delta.source,
          rawTranscript: raw,
          normalizedTokens: words,
          retainedTokens: words,
          rollingBufferTokens: next,
          provisionalBufferTokens: [],
          evaluationBufferTokens: next,
          matchedText: result.matchedText,
          confidence: result.confidence,
          moveDecision: 'manual/paused: no follow update',
          moveToTokenCalled: false,
          retentionDecision: 'retained',
          retentionReason: 'standard rolling buffer provider'
        });
        return next;
      }

      if (result.confidence >= HIGH_CONFIDENCE) {
        lowConfidenceCountRef.current = 0;
        const nextState = stateFromAlignment(result, previousToken, wasResyncing, 0);
        moveToToken(result.tokenIndex, nextState);
        appendTrace(`action: MOVED s${result.sentenceIndex} state=${nextState} (high-conf)`);
        setAlignmentBufferDebug({
          source: delta.source,
          rawTranscript: raw,
          normalizedTokens: words,
          retainedTokens: words,
          rollingBufferTokens: next,
          provisionalBufferTokens: [],
          evaluationBufferTokens: next,
          matchedText: result.matchedText,
          confidence: result.confidence,
          moveDecision: `moved to token ${result.tokenIndex} state=${nextState}`,
          moveToTokenCalled: true,
          retentionDecision: 'retained',
          retentionReason: 'standard rolling buffer provider'
        });
      } else {
        lowConfidenceCountRef.current += 1;
        const nextState = stateFromAlignment(result, previousToken, wasResyncing, lowConfidenceCountRef.current);
        setFollowState(nextState);
        appendTrace(`action: HELD state=${nextState} (low-conf)`);
        setAlignmentBufferDebug({
          source: delta.source,
          rawTranscript: raw,
          normalizedTokens: words,
          retainedTokens: words,
          rollingBufferTokens: next,
          provisionalBufferTokens: [],
          evaluationBufferTokens: next,
          matchedText: result.matchedText,
          confidence: result.confidence,
          moveDecision: `held state=${nextState} confidence below threshold`,
          moveToTokenCalled: false,
          retentionDecision: 'retained',
          retentionReason: 'standard rolling buffer provider'
        });
      }

      return next;
    });
  }, [moveToToken, appendTrace]);

  useEffect(() => {
    const manualOff = manualProviderRef.current.onDelta(processDelta);
    const mockOff = mockProviderRef.current.onDelta(processDelta);
    const liveOff = liveProviderRef.current.onDelta(processDelta);
    const liveStatusOff = liveProviderRef.current.onConnectionStatus(setLiveStatus);
    const localWhisperOff = localWhisperProviderRef.current.onDelta(processDelta);
    const localWhisperStatusOff = localWhisperProviderRef.current.onConnectionStatus(setLocalWhisperStatus);
    const doneOff = mockProviderRef.current.onDone(() => {
      setIsMockPlaying(false);
      if (selectedAsrProviderRef.current === 'mock') setFollowState('manual');
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
  }, [processDelta]);

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
        manuscriptText,
        currentTokenIndex,
        currentSentenceIndex,
        currentParagraphIndex,
        displaySettings,
        followState,
        selectedAsrProviderId,
        localWhisperSettings,
        mockScript,
        debugVisible
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    currentParagraphIndex,
    currentSentenceIndex,
    currentTokenIndex,
    debugVisible,
    displaySettings,
    followState,
    manuscriptText,
    mockScript,
    projectTitle,
    selectedAsrProviderId,
    localWhisperSettings
  ]);

  const toggleFollow = useCallback(() => {
    setFollowState((previous) => (previous === 'manual' ? 'following' : 'manual'));
  }, []);

  const togglePause = useCallback(() => {
    setFollowState((previous) => (previous === 'paused' ? 'following' : 'paused'));
  }, []);

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
    resyncArmedRef.current = true;
    lowConfidenceCountRef.current = 0;
    setFollowState('resyncing');
  }, []);

  const injectManual = useCallback(async () => {
    await manualProviderRef.current.start();
    setIsListening(true);
    manualProviderRef.current.pushText(manualTranscript);
    setManualTranscript('');
  }, [manualTranscript]);

  const playMock = useCallback(async () => {
    const lines = mockScript.split(/\r?\n/);
    const intervalMs = slowMockRef.current ? 2800 : 950;
    mockProviderRef.current.setScript(lines, intervalMs);
    setIsMockPlaying(true);
    if (followStateRef.current === 'manual' || followStateRef.current === 'paused') {
      setFollowState('following');
    }
    setControlsVisible(false);
    await mockProviderRef.current.start();
  }, [mockScript]);

  const stopMock = useCallback(async () => {
    await mockProviderRef.current.stop();
    setIsMockPlaying(false);
    setFollowState('manual');
  }, []);

  const startMicMonitor = useCallback(async () => {
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

  const toggleListening = useCallback(async () => {
    if (selectedAsrProviderRef.current === 'mock') {
      if (isMockPlaying) {
        await stopMock();
      } else {
        await playMock();
      }
      return;
    }

    if (selectedAsrProviderRef.current === 'openai-realtime') {
      if (liveStatus.listening) {
        await liveProviderRef.current.stop();
        setFollowState('manual');
      } else {
        try {
          await liveProviderRef.current.start();
          if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
            setFollowState('following');
          }
          if (displaySettings.autoHideControlsOnStart) {
            setControlsVisible(false);
          }
        } catch {
          // Provider status already carries the sanitized error; manual and mock remain usable.
        }
      }
      return;
    }

    if (selectedAsrProviderRef.current === 'local-whisper') {
      if (localWhisperStatus.listening) {
        await localWhisperProviderRef.current.stop();
        setFollowState('manual');
      } else {
        if (!localWhisperStatus.bridge.localWhisperBridgeAvailable) {
          await localWhisperProviderRef.current.refreshStatus().catch(() => undefined);
          if (!localWhisperProviderRef.current.getConnectionStatus().bridge.localWhisperBridgeAvailable) {
            return;
          }
        }
        try {
          await localWhisperProviderRef.current.start();
          if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
            setFollowState('following');
          }
          if (displaySettings.autoHideControlsOnStart) {
            setControlsVisible(false);
          }
        } catch {
          // Provider status already carries the error; manual, mock, and OpenAI remain usable.
        }
      }
      return;
    }

    if (isListening) {
      await manualProviderRef.current.stop();
      setIsListening(false);
      setFollowState('manual');
    } else {
      await manualProviderRef.current.start();
      setIsListening(true);
      if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
        setFollowState('following');
      }
      setControlsVisible(false);
    }
  }, [
    isListening,
    isMockPlaying,
    liveStatus.listening,
    localWhisperStatus.bridge.localWhisperBridgeAvailable,
    localWhisperStatus.listening,
    playMock,
    stopMock
  ]);

  const importTxt = useCallback(async () => {
    if (window.prompterApi?.openTextFile) {
      const result = await window.prompterApi.openTextFile();
      if (!result) return;
      setProjectTitle(result.name.replace(/\.[^.]+$/, '') || result.name);
      setManuscriptText(result.text);
      resetAlignmentContext();
      moveToToken(0, 'manual');
      return;
    }

    fileInputRef.current?.click();
  }, [moveToToken, resetAlignmentContext]);

  const localFileSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setProjectTitle(file.name.replace(/\.[^.]+$/, '') || file.name);
      setManuscriptText(String(reader.result ?? ''));
      resetAlignmentContext();
      moveToToken(0, 'manual');
      event.target.value = '';
    };
    reader.readAsText(file);
  }, [moveToToken, resetAlignmentContext]);

  const searchJump = useCallback(() => {
    const model = manuscriptRef.current;
    const found = searchManuscript(model, searchQuery, currentTokenRef.current + 1);
    if (found !== null) {
      resetAlignmentContext();
      moveToToken(found, 'manual');
      setAlignment({
        ...emptyAlignment(model, found),
        confidence: 1,
        matchedText: searchQuery,
        reason: 'Manual search jump.'
      });
    }
  }, [moveToToken, resetAlignmentContext, searchQuery]);

  const toggleFullScreen = useCallback(() => {
    void window.prompterApi?.toggleFullScreen();
  }, []);

  const toggleAlwaysOnTop = useCallback(() => {
    void window.prompterApi?.toggleAlwaysOnTop();
  }, []);

  const selectAsrProvider = useCallback((providerId: AsrProviderId) => {
    setSelectedAsrProviderId(coerceSelectedProvider(providerId, liveConfig, localWhisperSettings));
  }, [liveConfig, localWhisperSettings]);

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
      if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
        setFollowState('following');
      }
      setControlsVisible(false);
    } catch {
      // Provider status already carries the user-facing restart error.
    }
  }, [localWhisperDraftSettings, localWhisperStatus.listening]);

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
  const narrationStatus = deriveNarrationStatus({
    isRunning: selectedProviderListening,
    isStarting: selectedProviderStarting,
    followState,
    confidence: alignment.confidence,
    expectsMic: selectedProviderExpectsMic,
    micActive: selectedProviderMicActive,
    inputLevel: selectedInputLevel,
    isLagging: localQueueLagging,
    errorMessage: selectedProviderError,
    warningMessage: selectedProviderWarning
  });
  const startStopDisabled =
    selectedAsrProviderId === 'local-whisper' &&
    !selectedProviderListening &&
    !localWhisperStatus.bridge.localWhisperBridgeAvailable;

  return (
    <div className={`app-shell ${controlsVisible ? '' : 'controls-hidden'}`}>
      <ControlPanel
        projectTitle={projectTitle}
        onProjectTitleChange={setProjectTitle}
        manuscriptText={manuscriptText}
        onManuscriptTextChange={setManuscriptText}
        onImportTxt={importTxt}
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
          onToggleControls={() => setControlsVisible((visible) => !visible)}
        />
        <PrompterView
          model={manuscript}
          currentSentenceIndex={currentSentenceIndex}
          currentTokenIndex={currentTokenIndex}
          followState={followState}
          confidence={alignment.confidence}
          settings={displaySettings}
          layoutMode={controlsVisible ? 'with-controls' : 'prompter-only'}
          assistScrollLagging={localQueueLagging}
          scrollTestRequest={scrollTestRequest}
          onTraceScroll={onTraceScroll}
          onAssistStatus={onAssistStatus}
          onScrollAnimationStatus={onScrollAnimationStatus}
          onAnchorDebug={onAnchorDebug}
        />
      </div>
    </div>
  );
}
