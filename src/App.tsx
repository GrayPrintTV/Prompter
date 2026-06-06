import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ManualAsrProvider } from './asr/ManualAsrProvider';
import { MockAsrProvider } from './asr/MockAsrProvider';
import { DEFAULT_LOCAL_WHISPER_STATUS, LocalWhisperAsrProvider } from './asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from './asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider } from './asr/providerRegistry';
import { ControlPanel } from './components/ControlPanel';
import { PrompterView } from './components/PrompterView';
import { alignTranscript } from './domain/alignment';
import {
  buildManuscript,
  findParagraphIndexForSentence,
  findSentenceIndexForToken,
  searchManuscript,
  tokenIndexForParagraph,
  tokenIndexForSentence
} from './domain/manuscript';
import { stateFromAlignment } from './domain/scrollModel';
import { transcriptToTokens } from './domain/normalize';
import type {
  AlignmentResult,
  AsrProviderId,
  DisplaySettings,
  FollowState,
  LiveAsrConfigStatus,
  LiveAsrConnectionStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  ManuscriptModel,
  TranscriptDelta
} from './domain/types';
import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_LOCAL_WHISPER_SETTINGS,
  DEFAULT_MOCK_SCRIPT,
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

export default function App() {
  const stored = useMemo(() => loadSession(), []);
  const [projectTitle, setProjectTitle] = useState(stored?.projectTitle ?? 'Narration Session');
  const [manuscriptText, setManuscriptText] = useState(stored?.manuscriptText ?? SAMPLE_MANUSCRIPT);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>({
    ...DEFAULT_DISPLAY_SETTINGS,
    ...stored?.displaySettings
  });
  const [currentTokenIndex, setCurrentTokenIndex] = useState(stored?.currentTokenIndex ?? 0);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(stored?.currentSentenceIndex ?? 0);
  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(stored?.currentParagraphIndex ?? 0);
  const [followState, setFollowState] = useState<FollowState>(stored?.followState ?? 'manual');
  const [manualTranscript, setManualTranscript] = useState('');
  const [mockScript, setMockScript] = useState(stored?.mockScript ?? DEFAULT_MOCK_SCRIPT);
  const [liveConfig, setLiveConfig] = useState<LiveAsrConfigStatus>(DEFAULT_LIVE_CONFIG);
  const [liveStatus, setLiveStatus] = useState<LiveAsrConnectionStatus>(DEFAULT_LIVE_STATUS);
  const [localWhisperSettings, setLocalWhisperSettings] = useState<LocalWhisperSettings>({
    ...DEFAULT_LOCAL_WHISPER_SETTINGS,
    ...stored?.localWhisperSettings
  });
  const [localWhisperStatus, setLocalWhisperStatus] = useState<LocalWhisperStatus>(DEFAULT_LOCAL_WHISPER_STATUS);
  const [selectedAsrProviderId, setSelectedAsrProviderId] = useState<AsrProviderId>(
    (stored?.selectedAsrProviderId as AsrProviderId | undefined) ?? 'manual'
  );
  const [isListening, setIsListening] = useState(false);
  const [isMockPlaying, setIsMockPlaying] = useState(false);
  const [debugVisible, setDebugVisible] = useState(stored?.debugVisible ?? true);
  const [searchQuery, setSearchQuery] = useState('');
  const [transcriptBuffer, setTranscriptBuffer] = useState<string[]>([]);
  const [deltas, setDeltas] = useState<TranscriptDelta[]>([]);
  const [inputLevel, setInputLevel] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualProviderRef = useRef(new ManualAsrProvider());
  const mockProviderRef = useRef(new MockAsrProvider());
  const liveProviderRef = useRef(new OpenAiRealtimeAsrProvider());
  const localWhisperProviderRef = useRef(
    new LocalWhisperAsrProvider({
      ...DEFAULT_LOCAL_WHISPER_SETTINGS,
      ...stored?.localWhisperSettings
    })
  );
  const resyncArmedRef = useRef(false);
  const lowConfidenceCountRef = useRef(0);
  const manuscript = useMemo(() => buildManuscript(manuscriptText), [manuscriptText]);
  const manuscriptRef = useRef(manuscript);
  const currentTokenRef = useRef(currentTokenIndex);
  const followStateRef = useRef(followState);
  const [alignment, setAlignment] = useState<AlignmentResult>(() => emptyAlignment(manuscript, currentTokenIndex));
  const selectedAsrProviderRef = useRef(selectedAsrProviderId);

  useEffect(() => {
    manuscriptRef.current = manuscript;
    const clamped = clamp(currentTokenRef.current, 0, Math.max(manuscript.tokens.length - 1, 0));
    const sentenceIndex = findSentenceIndexForToken(manuscript, clamped);
    currentTokenRef.current = clamped;
    setCurrentTokenIndex(clamped);
    setCurrentSentenceIndex(sentenceIndex);
    setCurrentParagraphIndex(findParagraphIndexForSentence(manuscript, sentenceIndex));
    setAlignment(emptyAlignment(manuscript, clamped));
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

  const processDelta = useCallback((delta: TranscriptDelta) => {
    setDeltas((previous) => [...previous.slice(-19), delta]);
    const words = transcriptToTokens(delta.text);
    setInputLevel(delta.text.trim() ? clamp(0.25 + words.length / 10, 0.25, 1) : 0);

    if (words.length === 0) {
      setFollowState((previous) => (previous === 'manual' ? 'manual' : 'holding'));
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

      if (followStateRef.current === 'manual' || followStateRef.current === 'paused') {
        return next;
      }

      if (result.confidence >= 0.76) {
        lowConfidenceCountRef.current = 0;
        moveToToken(result.tokenIndex, stateFromAlignment(result, previousToken, wasResyncing, 0));
      } else {
        lowConfidenceCountRef.current += 1;
        setFollowState(stateFromAlignment(result, previousToken, wasResyncing, lowConfidenceCountRef.current));
      }

      return next;
    });
  }, [moveToToken]);

  useEffect(() => {
    const manualOff = manualProviderRef.current.onDelta(processDelta);
    const mockOff = mockProviderRef.current.onDelta(processDelta);
    const liveOff = liveProviderRef.current.onDelta(processDelta);
    const liveStatusOff = liveProviderRef.current.onConnectionStatus(setLiveStatus);
    const localWhisperOff = localWhisperProviderRef.current.onDelta(processDelta);
    const localWhisperStatusOff = localWhisperProviderRef.current.onConnectionStatus(setLocalWhisperStatus);
    const doneOff = mockProviderRef.current.onDone(() => setIsMockPlaying(false));
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
    moveToToken(tokenIndexForSentence(model, target), 'manual');
  }, [currentSentenceIndex, moveToToken]);

  const stepParagraph = useCallback((direction: -1 | 1) => {
    const model = manuscriptRef.current;
    const target = clamp(currentParagraphIndex + direction, 0, Math.max(model.paragraphs.length - 1, 0));
    moveToToken(tokenIndexForParagraph(model, target), 'manual');
  }, [currentParagraphIndex, moveToToken]);

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
    mockProviderRef.current.setScript(lines);
    setIsMockPlaying(true);
    if (followStateRef.current === 'manual' || followStateRef.current === 'paused') {
      setFollowState('following');
    }
    await mockProviderRef.current.start();
  }, [mockScript]);

  const stopMock = useCallback(async () => {
    await mockProviderRef.current.stop();
    setIsMockPlaying(false);
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
        if (followStateRef.current !== 'manual') setFollowState('paused');
      } else {
        try {
          await liveProviderRef.current.start();
          if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
            setFollowState('following');
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
        if (followStateRef.current !== 'manual') setFollowState('paused');
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
        } catch {
          // Provider status already carries the error; manual, mock, and OpenAI remain usable.
        }
      }
      return;
    }

    if (isListening) {
      await manualProviderRef.current.stop();
      setIsListening(false);
      if (followStateRef.current !== 'manual') setFollowState('paused');
    } else {
      await manualProviderRef.current.start();
      setIsListening(true);
      if (followStateRef.current === 'paused' || followStateRef.current === 'manual') {
        setFollowState('following');
      }
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
      setTranscriptBuffer([]);
      moveToToken(0, 'manual');
      return;
    }

    fileInputRef.current?.click();
  }, [moveToToken]);

  const localFileSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setProjectTitle(file.name.replace(/\.[^.]+$/, '') || file.name);
      setManuscriptText(String(reader.result ?? ''));
      setTranscriptBuffer([]);
      moveToToken(0, 'manual');
      event.target.value = '';
    };
    reader.readAsText(file);
  }, [moveToToken]);

  const searchJump = useCallback(() => {
    const model = manuscriptRef.current;
    const found = searchManuscript(model, searchQuery, currentTokenRef.current + 1);
    if (found !== null) {
      moveToToken(found, 'manual');
      setAlignment({
        ...emptyAlignment(model, found),
        confidence: 1,
        matchedText: searchQuery,
        reason: 'Manual search jump.'
      });
    }
  }, [moveToToken, searchQuery]);

  const toggleFullScreen = useCallback(() => {
    void window.prompterApi?.toggleFullScreen();
  }, []);

  const toggleAlwaysOnTop = useCallback(() => {
    void window.prompterApi?.toggleAlwaysOnTop();
  }, []);

  const selectAsrProvider = useCallback((providerId: AsrProviderId) => {
    setSelectedAsrProviderId(coerceSelectedProvider(providerId, liveConfig, localWhisperSettings));
  }, [liveConfig, localWhisperSettings]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const editable = isEditableTarget(event.target);

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

      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        document.getElementById('manuscript-search')?.focus();
        return;
      }

      if (editable) return;

      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        void toggleListening();
      } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFollow();
      } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        togglePause();
      } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'r') {
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
  const selectedInputLevel =
    selectedAsrProviderId === 'local-whisper'
      ? localWhisperStatus.mic.inputLevel
      : inputLevel;

  return (
    <div className="app-shell">
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
        localWhisperSettings={localWhisperSettings}
        onLocalWhisperSettingsChange={setLocalWhisperSettings}
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
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearchJump={searchJump}
        settings={displaySettings}
        onSettingsChange={setDisplaySettings}
        onToggleDebug={() => setDebugVisible((visible) => !visible)}
        onToggleFullScreen={toggleFullScreen}
        onToggleAlwaysOnTop={toggleAlwaysOnTop}
        debugVisible={debugVisible}
        deltas={deltas}
        transcriptBuffer={transcriptBuffer}
        alignment={alignment}
        currentTokenIndex={currentTokenIndex}
      />
      <PrompterView
        model={manuscript}
        currentSentenceIndex={currentSentenceIndex}
        followState={followState}
        confidence={alignment.confidence}
        settings={displaySettings}
      />
    </div>
  );
}
