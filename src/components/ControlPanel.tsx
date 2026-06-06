import type { ChangeEvent } from 'react';
import { DebugPanel } from './DebugPanel';
import { ShortcutHelp } from './ShortcutHelp';
import { StatusIndicator } from './StatusIndicator';
import { TortureTestPanel } from './TortureTestPanel';
import { getAsrProviderOptions } from '../asr/providerRegistry';
import type {
  AlignmentResult,
  AsrProviderId,
  DisplaySettings,
  FollowState,
  LiveAsrConfigStatus,
  LiveAsrConnectionStatus,
  LocalWhisperSettings,
  LocalWhisperSidecarPhase,
  LocalWhisperStatus,
  ManuscriptModel,
  MicCaptureState,
  TranscriptDelta
} from '../domain/types';

type Props = {
  projectTitle: string;
  onProjectTitleChange(title: string): void;
  manuscriptText: string;
  onManuscriptTextChange(text: string): void;
  onImportTxt(): void;
  onLocalFileSelected(event: ChangeEvent<HTMLInputElement>): void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  model: ManuscriptModel;
  selectedAsrProviderId: AsrProviderId;
  onSelectedAsrProviderChange(providerId: AsrProviderId): void;
  liveConfig: LiveAsrConfigStatus;
  liveStatus: LiveAsrConnectionStatus;
  localWhisperSettings: LocalWhisperSettings;
  onLocalWhisperSettingsChange(settings: LocalWhisperSettings): void;
  localWhisperStatus: LocalWhisperStatus;
  isListening: boolean;
  isMockPlaying: boolean;
  inputLevel: number;
  followState: FollowState;
  confidence: number;
  currentSentenceIndex: number;
  currentParagraphIndex: number;
  onStartStop(): void;
  onStartMicMonitor(): void;
  onStopMicMonitor(): void;
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

function formatMicCaptureState(state: MicCaptureState) {
  return state
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatSidecarPhase(phase: LocalWhisperSidecarPhase) {
  if (phase === 'model-loading') return 'Model loading';
  if (phase === 'returned-empty-transcript') return 'Returned empty transcript';
  return phase
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sourceForProvider(providerId: AsrProviderId) {
  if (providerId === 'openai-realtime') return 'openai-realtime';
  if (providerId === 'local-whisper') return 'local-whisper';
  if (providerId === 'mock') return 'mock';
  return 'manual';
}

export function getActiveAsrTranscriptHistory(
  providerId: AsrProviderId,
  deltas: TranscriptDelta[],
  localWhisperStatus: LocalWhisperStatus
) {
  if (providerId === 'local-whisper' && localWhisperStatus.transcriptHistory.length > 0) {
    return localWhisperStatus.transcriptHistory.slice(-5);
  }

  const source = sourceForProvider(providerId);
  return deltas
    .filter((delta) => delta.source === source)
    .slice(-5)
    .map((delta) => ({
      ...delta,
      displayText: delta.text || '[empty transcript]',
      isEmpty: delta.text.trim().length === 0
    }));
}

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
    selectedAsrProviderId,
    onSelectedAsrProviderChange,
    liveConfig,
    liveStatus,
    localWhisperSettings,
    onLocalWhisperSettingsChange,
    localWhisperStatus,
    isListening,
    isMockPlaying,
    inputLevel,
    followState,
    confidence,
    currentSentenceIndex,
    currentParagraphIndex,
    onStartStop,
    onStartMicMonitor,
    onStopMicMonitor,
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
  const providerOptions = getAsrProviderOptions(liveConfig, localWhisperSettings);
  const selectedProviderLabel =
    providerOptions.find((option) => option.id === selectedAsrProviderId)?.label ?? 'Manual';
  const localMic = selectedAsrProviderId === 'local-whisper' ? localWhisperStatus.mic : null;
  const transcriptHistory = getActiveAsrTranscriptHistory(selectedAsrProviderId, deltas, localWhisperStatus);
  const latestHeard = transcriptHistory.at(-1)?.displayText ||
    (selectedAsrProviderId === 'openai-realtime'
      ? liveStatus.lastTranscriptDelta
      : selectedAsrProviderId === 'local-whisper'
        ? localWhisperStatus.lastTranscriptDelta
        : '') ||
    'Nothing heard yet';
  const startStopLabel = selectedAsrProviderId === 'local-whisper'
    ? isListening ? 'Stop Following' : 'Start Following'
    : isListening ? 'Stop' : 'Start';

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

      <section className="panel-section">
        <h2>ASR Provider</h2>
        <select
          className="provider-select"
          value={selectedAsrProviderId}
          onChange={(event) => onSelectedAsrProviderChange(event.target.value as AsrProviderId)}
          aria-label="ASR provider"
        >
          {providerOptions.map((option) => (
            <option key={option.id} value={option.id} disabled={!option.enabled}>
              {option.label}{option.enabled ? '' : ' (not configured)'}
            </option>
          ))}
        </select>
        <dl className="asr-status-grid">
          <dt>Provider</dt>
          <dd>{selectedProviderLabel}</dd>
          <dt>Configured</dt>
          <dd>
            {selectedAsrProviderId === 'openai-realtime'
              ? liveConfig.configured ? 'Yes' : 'No'
              : selectedAsrProviderId === 'local-whisper'
                ? localWhisperStatus.configured ? 'Yes' : 'No'
                : 'Local'}
          </dd>
          <dt>Connection</dt>
          <dd>
            {selectedAsrProviderId === 'openai-realtime'
              ? liveStatus.connected ? 'Connected' : 'Disconnected'
              : selectedAsrProviderId === 'local-whisper'
                ? localWhisperStatus.sidecarRunning ? 'Sidecar running' : 'Sidecar stopped'
                : 'Local'}
          </dd>
          {selectedAsrProviderId === 'local-whisper' ? (
            <>
              <dt>Sidecar</dt>
              <dd>{formatSidecarPhase(localWhisperStatus.modelPhase)}</dd>
            </>
          ) : null}
          <dt>Listening</dt>
          <dd>{isListening || isMockPlaying ? 'Listening' : 'Not listening'}</dd>
          <dt>Last delta</dt>
          <dd>{latestHeard}</dd>
          <dt>Error</dt>
          <dd>
            {selectedAsrProviderId === 'openai-realtime'
              ? liveStatus.errorMessage ?? 'None'
              : selectedAsrProviderId === 'local-whisper'
                ? localWhisperStatus.errorMessage ?? 'None'
                : 'None'}
          </dd>
          {localMic ? (
            <>
              <dt>Mic state</dt>
              <dd>{formatMicCaptureState(localMic.captureState)}</dd>
              <dt>Input</dt>
              <dd>{localMic.deviceLabel || 'Unavailable until permission is granted'}</dd>
              <dt>Mic error</dt>
              <dd>{localMic.errorMessage ?? 'None'}</dd>
              <dt>Warning</dt>
              <dd>{localWhisperStatus.chunk.warningMessage ?? 'None'}</dd>
            </>
          ) : null}
        </dl>
        {localMic ? (
          <div className="mic-diagnostics">
            <div className="mic-diagnostics-header">
              <span>Mic Monitor</span>
              <button
                type="button"
                onClick={localMic.monitorActive ? onStopMicMonitor : onStartMicMonitor}
              >
                {localMic.monitorActive ? 'Stop Monitor' : 'Start Monitor'}
              </button>
            </div>
            <div className="level-meter live-level-meter" aria-label="Live microphone input level">
              <div style={{ width: `${Math.round(inputLevel * 100)}%` }} />
            </div>
            <dl className="chunk-counter-grid">
              <dt>Recorded</dt>
              <dd>{localWhisperStatus.chunk.chunksRecorded}</dd>
              <dt>Sent</dt>
              <dd>{localWhisperStatus.chunk.chunksSentToMain}</dd>
              <dt>Sidecar</dt>
              <dd>{localWhisperStatus.chunk.chunksReceivedBySidecar}</dd>
              <dt>Returned</dt>
              <dd>{localWhisperStatus.chunk.chunksReturnedFromSidecar}</dd>
              <dt>Bytes</dt>
              <dd>{localWhisperStatus.chunk.lastChunkBytes || 'None'}</dd>
              <dt>Pending</dt>
              <dd>{localWhisperStatus.chunk.pendingResponses}</dd>
              <dt>Last text</dt>
              <dd>{localWhisperStatus.chunk.lastTranscriptText || 'None'}</dd>
              <dt>Sidecar error</dt>
              <dd>{localWhisperStatus.chunk.lastSidecarError ?? 'None'}</dd>
            </dl>
            <ol className="mic-log">
              {(localMic.log.length ? localMic.log.slice(-6) : ['No microphone activity yet.']).map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ol>
          </div>
        ) : null}
        <div className="asr-transcript-panel">
          <div className="asr-transcript-header">
            <span>Heard</span>
            <span>{transcriptHistory.length} recent</span>
          </div>
          <div className="asr-latest-transcript">{latestHeard}</div>
          <ol className="asr-transcript-history">
            {(transcriptHistory.length ? transcriptHistory : [{
              displayText: 'No ASR transcript yet.',
              timestampMs: 0,
              isEmpty: true
            }]).map((item, index) => (
              <li
                key={`${item.timestampMs}-${index}-${item.displayText}`}
                className={item.isEmpty ? 'empty-transcript' : undefined}
              >
                {item.displayText}
              </li>
            ))}
          </ol>
        </div>
        {selectedAsrProviderId === 'local-whisper' ? (
          <div className="local-whisper-settings">
            <label>
              Python
              <input
                value={localWhisperSettings.pythonExecutablePath}
                onChange={(event) =>
                  onLocalWhisperSettingsChange({
                    ...localWhisperSettings,
                    pythonExecutablePath: event.target.value
                  })
                }
              />
            </label>
            <label>
              Model
              <input
                value={localWhisperSettings.modelName}
                onChange={(event) =>
                  onLocalWhisperSettingsChange({ ...localWhisperSettings, modelName: event.target.value })
                }
              />
            </label>
            <label>
              Device
              <select
                value={localWhisperSettings.device}
                onChange={(event) =>
                  onLocalWhisperSettingsChange({ ...localWhisperSettings, device: event.target.value })
                }
              >
                <option value="cpu">cpu</option>
                <option value="cuda">cuda</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label>
              Compute
              <select
                value={localWhisperSettings.computeType}
                onChange={(event) =>
                  onLocalWhisperSettingsChange({ ...localWhisperSettings, computeType: event.target.value })
                }
              >
                <option value="int8">int8</option>
                <option value="float16">float16</option>
                <option value="float32">float32</option>
              </select>
            </label>
            <label>
              Chunk s
              <input
                type="number"
                min={1}
                max={20}
                step={0.5}
                value={localWhisperSettings.chunkDurationSeconds}
                onChange={(event) =>
                  onLocalWhisperSettingsChange({
                    ...localWhisperSettings,
                    chunkDurationSeconds: Number(event.target.value)
                  })
                }
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="panel-section button-grid">
        <button type="button" onClick={onStartStop}>{startStopLabel}</button>
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

      <TortureTestPanel
        model={model}
        currentTokenIndex={currentTokenIndex}
        onLoadManuscript={onManuscriptTextChange}
      />

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
