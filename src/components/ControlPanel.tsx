import type { ChangeEvent } from 'react';
import { DebugPanel } from './DebugPanel';
import { ShortcutHelp } from './ShortcutHelp';
import { StatusIndicator } from './StatusIndicator';
import type { AlignmentResult, DisplaySettings, FollowState, ManuscriptModel, TranscriptDelta } from '../domain/types';

type Props = {
  projectTitle: string;
  onProjectTitleChange(title: string): void;
  manuscriptText: string;
  onManuscriptTextChange(text: string): void;
  onImportTxt(): void;
  onLocalFileSelected(event: ChangeEvent<HTMLInputElement>): void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  model: ManuscriptModel;
  isListening: boolean;
  isMockPlaying: boolean;
  inputLevel: number;
  followState: FollowState;
  confidence: number;
  currentSentenceIndex: number;
  currentParagraphIndex: number;
  onStartStop(): void;
  onToggleFollow(): void;
  onTogglePause(): void;
  onStepSentence(direction: -1 | 1): void;
  onStepParagraph(direction: -1 | 1): void;
  onResync(): void;
  manualTranscript: string;
  onManualTranscriptChange(text: string): void;
  onInjectManual(): void;
  mockScript: string;
  onMockScriptChange(text: string): void;
  onPlayMock(): void;
  onStopMock(): void;
  searchQuery: string;
  onSearchQueryChange(text: string): void;
  onSearchJump(): void;
  settings: DisplaySettings;
  onSettingsChange(settings: DisplaySettings): void;
  onToggleDebug(): void;
  onToggleFullScreen(): void;
  onToggleAlwaysOnTop(): void;
  debugVisible: boolean;
  deltas: TranscriptDelta[];
  transcriptBuffer: string[];
  alignment: AlignmentResult;
  currentTokenIndex: number;
};

export function ControlPanel(props: Props) {
  const {
    projectTitle,
    onProjectTitleChange,
    manuscriptText,
    onManuscriptTextChange,
    onImportTxt,
    onLocalFileSelected,
    fileInputRef,
    model,
    isListening,
    isMockPlaying,
    inputLevel,
    followState,
    confidence,
    currentSentenceIndex,
    currentParagraphIndex,
    onStartStop,
    onToggleFollow,
    onTogglePause,
    onStepSentence,
    onStepParagraph,
    onResync,
    manualTranscript,
    onManualTranscriptChange,
    onInjectManual,
    mockScript,
    onMockScriptChange,
    onPlayMock,
    onStopMock,
    searchQuery,
    onSearchQueryChange,
    onSearchJump,
    settings,
    onSettingsChange,
    onToggleDebug,
    onToggleFullScreen,
    onToggleAlwaysOnTop,
    debugVisible,
    deltas,
    transcriptBuffer,
    alignment,
    currentTokenIndex
  } = props;

  return (
    <aside className="control-panel">
      <header className="app-header">
        <div>
          <label htmlFor="project-title">Project</label>
          <input
            id="project-title"
            value={projectTitle}
            onChange={(event) => onProjectTitleChange(event.target.value)}
          />
        </div>
        <button type="button" onClick={onToggleFullScreen}>Full</button>
      </header>

      <section className="panel-section">
        <StatusIndicator state={followState} confidence={confidence} isListening={isListening || isMockPlaying} />
        <div className="position-line">
          <span>Paragraph {Math.min(currentParagraphIndex + 1, model.paragraphs.length || 1)} / {model.paragraphs.length || 1}</span>
          <span>Sentence {Math.min(currentSentenceIndex + 1, model.sentences.length || 1)} / {model.sentences.length || 1}</span>
        </div>
        <div className="level-meter" aria-label="Input level">
          <div style={{ width: `${Math.round(inputLevel * 100)}%` }} />
        </div>
      </section>

      <section className="panel-section button-grid">
        <button type="button" onClick={onStartStop}>{isListening ? 'Stop' : 'Start'}</button>
        <button type="button" onClick={onToggleFollow}>{followState === 'manual' ? 'Follow' : 'Manual'}</button>
        <button type="button" onClick={onTogglePause}>{followState === 'paused' ? 'Resume' : 'Pause'}</button>
        <button type="button" onClick={onResync}>Resync</button>
        <button type="button" onClick={() => onStepSentence(-1)}>Back Sent</button>
        <button type="button" onClick={() => onStepSentence(1)}>Next Sent</button>
        <button type="button" onClick={() => onStepParagraph(-1)}>Back Para</button>
        <button type="button" onClick={() => onStepParagraph(1)}>Next Para</button>
      </section>

      <section className="panel-section">
        <h2>Manuscript</h2>
        <div className="inline-actions">
          <button type="button" onClick={onImportTxt}>Import TXT</button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            onChange={onLocalFileSelected}
          />
          <span>{model.tokens.length.toLocaleString()} words</span>
        </div>
        <textarea
          className="manuscript-input"
          value={manuscriptText}
          onChange={(event) => onManuscriptTextChange(event.target.value)}
          spellCheck={false}
        />
      </section>

      <section className="panel-section">
        <h2>Manual Transcript</h2>
        <textarea
          className="transcript-input"
          value={manualTranscript}
          onChange={(event) => onManualTranscriptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              onInjectManual();
            }
          }}
          placeholder="Type the words you just spoke..."
        />
        <button type="button" onClick={onInjectManual}>Inject Transcript</button>
      </section>

      <section className="panel-section">
        <h2>Mock Playback</h2>
        <textarea
          className="mock-input"
          value={mockScript}
          onChange={(event) => onMockScriptChange(event.target.value)}
          spellCheck={false}
        />
        <div className="inline-actions">
          <button type="button" onClick={onPlayMock} disabled={isMockPlaying}>Play Mock</button>
          <button type="button" onClick={onStopMock} disabled={!isMockPlaying}>Stop Mock</button>
        </div>
      </section>

      <section className="panel-section">
        <h2>Search</h2>
        <div className="search-row">
          <input
            id="manuscript-search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearchJump();
            }}
            placeholder="Find phrase"
          />
          <button type="button" onClick={onSearchJump}>Jump</button>
        </div>
      </section>

      <section className="panel-section">
        <h2>Display</h2>
        <div className="settings-grid">
          <label>
            Font
            <input
              type="number"
              min={22}
              max={78}
              value={settings.fontSizePx}
              onChange={(event) => onSettingsChange({ ...settings, fontSizePx: Number(event.target.value) })}
            />
          </label>
          <label>
            Line
            <input
              type="number"
              min={1.1}
              max={2.2}
              step={0.05}
              value={settings.lineHeight}
              onChange={(event) => onSettingsChange({ ...settings, lineHeight: Number(event.target.value) })}
            />
          </label>
          <label>
            Width
            <input
              type="number"
              min={42}
              max={92}
              value={settings.textWidthCh}
              onChange={(event) => onSettingsChange({ ...settings, textWidthCh: Number(event.target.value) })}
            />
          </label>
          <label>
            Zone
            <input
              type="number"
              min={45}
              max={75}
              value={settings.readingZonePercent}
              onChange={(event) => onSettingsChange({ ...settings, readingZonePercent: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            onClick={() => onSettingsChange({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          >
            {settings.theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button type="button" onClick={onToggleAlwaysOnTop}>Top</button>
          <button type="button" onClick={onToggleDebug}>{debugVisible ? 'Hide Debug' : 'Debug'}</button>
        </div>
      </section>

      <section className="panel-section">
        <h2>Shortcuts</h2>
        <ShortcutHelp />
      </section>

      <DebugPanel
        visible={debugVisible}
        deltas={deltas}
        transcriptBuffer={transcriptBuffer}
        alignment={alignment}
        currentTokenIndex={currentTokenIndex}
        followState={followState}
      />
    </aside>
  );
}
