import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ManualAsrProvider } from './asr/ManualAsrProvider';
import { MockAsrProvider } from './asr/MockAsrProvider';
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
import type { AlignmentResult, DisplaySettings, FollowState, ManuscriptModel, TranscriptDelta } from './domain/types';
import { DEFAULT_DISPLAY_SETTINGS, DEFAULT_MOCK_SCRIPT, SAMPLE_MANUSCRIPT } from './state/appStore';
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
  const resyncArmedRef = useRef(false);
  const lowConfidenceCountRef = useRef(0);
  const manuscript = useMemo(() => buildManuscript(manuscriptText), [manuscriptText]);
  const manuscriptRef = useRef(manuscript);
  const currentTokenRef = useRef(currentTokenIndex);
  const followStateRef = useRef(followState);
  const [alignment, setAlignment] = useState<AlignmentResult>(() => emptyAlignment(manuscript, currentTokenIndex));

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
    const doneOff = mockProviderRef.current.onDone(() => setIsMockPlaying(false));
    return () => {
      manualOff();
      mockOff();
      doneOff();
    };
  }, [processDelta]);

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
    projectTitle
  ]);

  const toggleListening = useCallback(async () => {
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
  }, [isListening]);

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
        isListening={isListening}
        isMockPlaying={isMockPlaying}
        inputLevel={inputLevel}
        followState={followState}
        confidence={alignment.confidence}
        currentSentenceIndex={currentSentenceIndex}
        currentParagraphIndex={currentParagraphIndex}
        onStartStop={toggleListening}
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
