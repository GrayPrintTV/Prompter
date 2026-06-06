import { useState, useEffect, type ChangeEvent } from 'react';
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
  traceLog?: string[];
};

function formatMicCaptureState(state: MicCaptureState) {
  return state
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatSidecarPhase(phase: LocalWhisperSidecarPhase) {
  if (phase === 'model-loading') return 'Model loading';
  if (phase === 'process-started') return 'Process started';
  if (phase === 'returned-empty-transcript') return 'Returned empty transcript';
  return phase
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDiagnosticBoolean(value: boolean | null) {
  if (value === null) return 'Unknown';
  return value ? 'Yes' : 'No';
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
    return localWhisperStatus.transcriptHistory.slice(-25);
  }

  const source = sourceForProvider(providerId);
  return deltas
    .filter((delta) => delta.source === source)
    .slice(-25)
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
    currentTokenIndex,
    traceLog
  } = props;
  const providerOptions = getAsrProviderOptions(liveConfig, localWhisperSettings);
  const selectedProviderLabel =
    providerOptions.find((option) => option.id === selectedAsrProviderId)?.label ?? 'Manual';
  const localMic = selectedAsrProviderId === 'local-whisper' ? localWhisperStatus.mic : null;
  const localBridgeUnavailable =
    selectedAsrProviderId === 'local-whisper' && !localWhisperStatus.bridge.localWhisperBridgeAvailable;
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
  const startStopDisabled = localBridgeUnavailable && !isListening;

  // Collapsed state for sections per UX task. Defaults: advanced/dev/bridge/mock/manual/torture/search? /display/shortcuts collapsed to declutter.
  // Persist to localStorage (easy).
  const [sectionsCollapsed, setSectionsCollapsed] = useState(() => {
    const defaults = {
      mock: true,
      manual: true,
      torture: true,
      search: false, // keep visible as it's useful with manuscript
      display: true,
      shortcuts: true,
      advanced: true,
      developer: true,
      bridge: true,
      trace: true,
      chunk: true
    };
    try {
      const saved = localStorage.getItem('np-collapsed-sections');
      if (saved) {
        return { ...defaults, ...JSON.parse(saved) };
      }
    } catch {}
    return defaults;
  });

  const toggleSection = (key: string) => {
    const next = { ...sectionsCollapsed, [key]: !sectionsCollapsed[key as keyof typeof sectionsCollapsed] };
    setSectionsCollapsed(next);
    try {
      localStorage.setItem('np-collapsed-sections', JSON.stringify(next));
    } catch {}
  };

  // Helper to render collapsible section header
  const CollapsibleHeader = ({ title, keyName, defaultOpen = false }: { title: string; keyName: string; defaultOpen?: boolean }) => {
    const isCollapsed = sectionsCollapsed[keyName as keyof typeof sectionsCollapsed] ?? !defaultOpen;
    return (
      <h2 onClick={() => toggleSection(keyName)} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {title} {isCollapsed ? '▶' : '▼'}
      </h2>
    );
  };

  // Local Whisper health indicator (exact states from req)
  const getLwHealth = () => {
    const s = localWhisperStatus;
    const chunk = s.chunk || {};
    const rt = chunk.lastRealtimeFactor || 0;
    const hasStaleDrop = (chunk.staleChunksDropped || 0) > 0;
    const hasSilSup = (chunk.silenceChunksSuppressed || 0) > 0;
    const err = s.errorMessage || (s.modelPhase === 'error');
    const warningMsg = (chunk.warningMessage || '').toLowerCase();
    const isBehind = rt > 1 || warningMsg.includes('behind') || warningMsg.includes('backing up') || hasStaleDrop;
    const isSilSup = hasSilSup || warningMsg.includes('silence suppression');
    if (err || s.modelPhase === 'error') {
      return { label: 'Sidecar failed', type: 'error' };
    }
    if (isBehind) {
      return { label: 'Whisper is behind', type: 'warning' };
    }
    if (warningMsg.includes('queue') || chunk.queueLength >= (chunk.maxQueueLength || 4)) {
      return { label: 'Queue backing up', type: 'warning' };
    }
    if (isSilSup) {
      return { label: 'Using silence suppression', type: 'warning' };
    }
    if (s.listening && followState === 'following') {
      return { label: 'Following', type: 'good' };
    }
    if (s.listening || isListening) {
      return { label: 'Listening', type: 'good' };
    }
    return { label: 'Idle', type: 'good' };
  };

  const lwHealth = getLwHealth();

  // Compact pipeline viz (simple text badges per req: OK/Waiting/Warning/Error)
  const getPipeline = () => {
    const s = localWhisperStatus;
    const chunk = s.chunk || {};
    const micActive = !!(localMic && (localMic.captureState === 'stream-active' || (localMic.inputLevel || 0) > 0.05));
    const qLen = chunk.queueLength || 0;
    const qMax = chunk.maxQueueLength || 4;
    const rt = chunk.lastRealtimeFactor || 0;
    const hasRecentHeard = !!(transcriptHistory && transcriptHistory.some((h: any) => h && !h.isEmpty && h.displayText && !h.displayText.includes('[')));
    const conf = confidence || 0;
    const isFollowing = followState === 'following';
    const phase = s.modelPhase || '';

    const mic = micActive ? 'OK' : 'Waiting';
    let queue = 'Clear';
    if (qLen >= qMax) queue = 'Full';
    else if (qLen > 0) queue = `${qLen} waiting`;
    if ((chunk.staleChunksDropped || 0) > 0) queue = 'Dropping stale';

    let whisper = 'OK';
    if (phase === 'error') whisper = 'Error';
    else if (rt > 1.2 || phase === 'transcribing' && rt > 0.8) whisper = 'Warning';
    else if (phase === 'transcribing') whisper = 'Waiting';

    const heard = hasRecentHeard ? 'OK' : 'Waiting';
    const match = conf >= 0.76 ? 'OK' : conf > 0.5 ? 'Waiting' : 'Warning';
    const scroll = isFollowing && conf >= 0.76 ? 'OK' : isFollowing ? 'Waiting' : 'Waiting';

    return `Mic: ${mic} → Queue: ${queue} → Whisper: ${whisper} → Heard: ${heard} → Match: ${match} → Scroll: ${scroll}`;
  };

  const pipelineViz = getPipeline();

  // Human readable RT factor (lower better; >1 = lag)
  const getRtText = () => {
    const rt = (localWhisperStatus.chunk && localWhisperStatus.chunk.lastRealtimeFactor) || 0;
    if (rt <= 0) return '';
    if (rt < 0.9) return `${rt.toFixed(1)}x realtime: keeping up`;
    if (rt < 1.2) return `${rt.toFixed(1)}x realtime: near realtime`;
    if (rt < 2) return `${rt.toFixed(1)}x realtime: slower than realtime`;
    return `${rt.toFixed(1)}x realtime: badly behind`;
  };

  // Human readable queue
  const getQueueText = () => {
    const c = localWhisperStatus.chunk || {};
    const len = c.queueLength || 0;
    const max = c.maxQueueLength || 4;
    const stale = c.staleChunksDropped || 0;
    if (stale > 0) return 'Dropping stale audio';
    if (len === 0) return 'Queue clear';
    if (len >= max) return 'Queue full';
    return `${len} chunk${len > 1 ? 's' : ''} waiting`;
  };

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

      {/* Listening - default visible core controls per req */}
      <section className="panel-section">
        <h2>Listening</h2>
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

        {/* Monitor / Following controls - default visible */}
        <div className="inline-actions" style={{marginBottom: '8px'}}>
          {selectedAsrProviderId === 'local-whisper' && (
            <button
              type="button"
              onClick={localMic && localMic.monitorActive ? onStopMicMonitor : onStartMicMonitor}
            >
              {localMic && localMic.monitorActive ? 'Stop Monitor' : 'Start Monitor'}
            </button>
          )}
          <button type="button" onClick={onStartStop} disabled={startStopDisabled}>{startStopLabel}</button>
          <button type="button" onClick={onToggleFollow}>{followState === 'manual' ? 'Follow' : 'Manual'}</button>
          <button type="button" onClick={onTogglePause}>{followState === 'paused' ? 'Resume' : 'Pause'}</button>
        </div>

        {/* Local Whisper Health indicator (exact states) + human readable RT + queue */}
        {selectedAsrProviderId === 'local-whisper' && (
          <div style={{margin: '6px 0', fontSize: '0.95em'}}>
            <div>
              <strong>Local Whisper Health:</strong> <span style={{fontWeight: 'bold', color: lwHealth.type === 'error' ? 'red' : lwHealth.type === 'warning' ? 'orange' : 'green'}}>{lwHealth.label}</span>
            </div>
            {getRtText() && <div>{getRtText()}</div>}
            <div>{getQueueText()}</div>
            {/* Key warning if behind - default visible */}
            {localWhisperStatus.chunk && localWhisperStatus.chunk.warningMessage && (
              <div style={{color: 'orange', fontSize: '0.9em'}}>⚠ {localWhisperStatus.chunk.warningMessage}</div>
            )}
          </div>
        )}

        {/* Compact pipeline visualization (text badges, OK/Waiting/Warning/Error) */}
        {selectedAsrProviderId === 'local-whisper' && (
          <div style={{fontFamily: 'monospace', fontSize: '0.85em', margin: '4px 0', whiteSpace: 'pre-wrap'}}>
            {pipelineViz}
          </div>
        )}

        {/* Basic asr status (high level only; deep bridge moved to Advanced) */}
        <dl className="asr-status-grid" style={{fontSize: '0.9em'}}>
          <dt>Provider</dt>
          <dd>{selectedProviderLabel}</dd>
          <dt>Listening</dt>
          <dd>{isListening || isMockPlaying ? 'Listening' : 'Not listening'}</dd>
          <dt>Last delta</dt>
          <dd>{latestHeard}</dd>
          <dt>Error</dt>
          <dd>
            {selectedAsrProviderId === 'openai-realtime'
              ? liveStatus.errorMessage ?? 'None'
              : selectedAsrProviderId === 'local-whisper'
                ? localWhisperStatus.errorMessage ?? localWhisperStatus.bridge.errorMessage ?? 'None'
                : 'None'}
          </dd>
        </dl>
      </section>

      {/* Local Whisper Health - dedicated, with indicator */}
      {selectedAsrProviderId === 'local-whisper' && (
        <section className="panel-section">
          <h2>Local Whisper Health</h2>
          <div>
            <span style={{fontWeight: 'bold', color: lwHealth.type === 'error' ? 'red' : lwHealth.type === 'warning' ? 'orange' : 'green'}}>{lwHealth.label}</span>
          </div>
          {getRtText() && <div style={{fontSize: '0.9em'}}>{getRtText()}</div>}
          <div style={{fontSize: '0.9em'}}>{getQueueText()}</div>
          {localWhisperStatus.chunk && localWhisperStatus.chunk.warningMessage && (
            <div style={{color:'orange', fontSize:'0.85em'}}>Warning: {localWhisperStatus.chunk.warningMessage}</div>
          )}
        </section>
      )}

      {/* Heard / Transcript - prominent, improved per req */}
      <div className="asr-transcript-panel">
        <div className="asr-transcript-header">
          <span>Heard / Transcript</span>
          <span>{transcriptHistory.length} recent</span>
          <button
            type="button"
            onClick={() => {
              const lines = transcriptHistory.map((item, i) => `${i + 1}. ${item.displayText}`).join('\n');
              const text = `ASR log (${selectedProviderLabel}):\n${lines}`;
              void navigator.clipboard.writeText(text).catch(() => undefined);
            }}
            title="Copy ASR transcript log to clipboard"
          >
            Copy
          </button>
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
              style={item.isEmpty ? {opacity: 0.6, fontStyle: 'italic'} : undefined}
              title={item.isEmpty ? 'Silence or no speech detected' : undefined}
            >
              {item.displayText}
            </li>
          ))}
        </ol>
      </div>

      {/* Navigation - basic nav buttons, default visible */}
      <section className="panel-section button-grid">
        <h2>Navigation</h2>
        <button type="button" onClick={onStartStop} disabled={startStopDisabled}>{startStopLabel}</button>
        <button type="button" onClick={onToggleFollow}>{followState === 'manual' ? 'Follow' : 'Manual'}</button>
        <button type="button" onClick={onTogglePause}>{followState === 'paused' ? 'Resume' : 'Pause'}</button>
        <button type="button" onClick={onResync}>Resync</button>
        <button type="button" onClick={() => onStepSentence(-1)}>Back Sent</button>
        <button type="button" onClick={() => onStepSentence(1)}>Next Sent</button>
        <button type="button" onClick={() => onStepParagraph(-1)}>Back Para</button>
        <button type="button" onClick={() => onStepParagraph(1)}>Next Para</button>
      </section>

      {/* Manuscript - import visible, textarea here (core but grouped) */}
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

      {/* Advanced Diagnostics - default collapsed (bridge, some status, detailed if any) */}
      <section className="panel-section">
        <CollapsibleHeader title="Advanced Diagnostics" keyName="advanced" />
        {!sectionsCollapsed.advanced && (
          <div>
            {/* High-level status already in Listening; here the deep LW bridge diags moved from main ASR dl */}
            {selectedAsrProviderId === 'local-whisper' && (
              <details open={false}>
                <summary style={{cursor:'pointer'}}>Bridge Diagnostics (advanced)</summary>
                <dl className="asr-status-grid" style={{fontSize:'0.85em'}}>
                  <dt>Electron bridge</dt><dd>{formatDiagnosticBoolean(localWhisperStatus.bridge.electronBridgeAvailable)}</dd>
                  <dt>Whisper bridge</dt><dd>{formatDiagnosticBoolean(localWhisperStatus.bridge.localWhisperBridgeAvailable)}</dd>
                  <dt>IPC handlers</dt><dd>{formatDiagnosticBoolean(localWhisperStatus.bridge.ipcHandlersRegistered)}</dd>
                  <dt>prompterApi</dt><dd>{localWhisperStatus.bridge.prompterApiType}</dd>
                  <dt>ping</dt><dd>{localWhisperStatus.bridge.pingType === 'function' ? localWhisperStatus.bridge.pingResult ?? 'No result' : localWhisperStatus.bridge.pingType}</dd>
                  <dt>Preload error</dt><dd>{localWhisperStatus.bridge.preloadErrorMessage ?? localWhisperStatus.bridge.preloadDiagnosticErrorMessage ?? 'None'}</dd>
                  <dt>Sidecar</dt><dd>{formatSidecarPhase(localWhisperStatus.modelPhase)}</dd>
                </dl>
              </details>
            )}
            {/* Any other advanced status can go here; detailed chunk counters moved to Developer */}
          </div>
        )}
      </section>

      {/* Developer Tools - default collapsed (mock, manual, torture, search, shortcuts, debug toggle, raw trace via DebugPanel, detailed counters) */}
      <section className="panel-section">
        <CollapsibleHeader title="Developer Tools" keyName="developer" />
        {!sectionsCollapsed.developer && (
          <div>
            {/* LW settings (was always visible for LW) moved here to declutter */}
            {selectedAsrProviderId === 'local-whisper' && (
              <div className="local-whisper-settings" style={{marginBottom: '8px'}}>
                <label>Python <input value={localWhisperSettings.pythonExecutablePath} onChange={(e) => onLocalWhisperSettingsChange({...localWhisperSettings, pythonExecutablePath: e.target.value})} /></label>
                <label>Model <input value={localWhisperSettings.modelName} onChange={(e) => onLocalWhisperSettingsChange({...localWhisperSettings, modelName: e.target.value})} /></label>
                <label>Device <select value={localWhisperSettings.device} onChange={(e) => onLocalWhisperSettingsChange({...localWhisperSettings, device: e.target.value})}><option value="cpu">cpu</option><option value="cuda">cuda</option><option value="auto">auto</option></select></label>
                <label>Compute <select value={localWhisperSettings.computeType} onChange={(e) => onLocalWhisperSettingsChange({...localWhisperSettings, computeType: e.target.value})}><option value="int8">int8</option><option value="float16">float16</option><option value="float32">float32</option></select></label>
                <label>Chunk s <input type="number" min={1} max={20} step={0.5} value={localWhisperSettings.chunkDurationSeconds} onChange={(e) => onLocalWhisperSettingsChange({...localWhisperSettings, chunkDurationSeconds: Number(e.target.value)})} /></label>
              </div>
            )}

            {/* Detailed chunk counters (moved from default) */}
            <details open={false} style={{marginBottom:'6px'}}>
              <summary style={{cursor:'pointer', fontSize:'0.9em'}}>Detailed Chunk Counters</summary>
              {localMic && (
                <dl className="chunk-counter-grid" style={{fontSize:'0.8em'}}>
                  <dt>Recorded</dt><dd>{localWhisperStatus.chunk.chunksRecorded}</dd>
                  <dt>Queued</dt><dd>{localWhisperStatus.chunk.chunksQueued}</dd>
                  <dt>Sent</dt><dd>{localWhisperStatus.chunk.chunksSentToMain}</dd>
                  <dt>Dropped</dt><dd>{localWhisperStatus.chunk.chunksDropped}</dd>
                  <dt>Sidecar</dt><dd>{localWhisperStatus.chunk.chunksReceivedBySidecar}</dd>
                  <dt>Returned</dt><dd>{localWhisperStatus.chunk.chunksReturnedFromSidecar}</dd>
                  <dt>Empty</dt><dd>{localWhisperStatus.chunk.chunksEmpty}</dd>
                  <dt>Failed</dt><dd>{localWhisperStatus.chunk.chunksFailed}</dd>
                  <dt>Pending</dt><dd>{localWhisperStatus.chunk.pendingResponses}</dd>
                  <dt>Last text</dt><dd>{localWhisperStatus.chunk.lastTranscriptText || 'None'}</dd>
                  <dt>Sidecar error</dt><dd>{localWhisperStatus.chunk.lastSidecarError ?? 'None'}</dd>
                </dl>
              )}
            </details>

            {/* Manual Transcript - default collapsed */}
            <details open={!sectionsCollapsed.manual} onToggle={() => {}} style={{marginBottom:'4px'}}>
              <summary style={{cursor:'pointer'}} onClick={(e) => { e.preventDefault(); toggleSection('manual'); }}>Manual Transcript {sectionsCollapsed.manual ? '▶' : '▼'}</summary>
              {!sectionsCollapsed.manual && (
                <div>
                  <textarea className="transcript-input" value={manualTranscript} onChange={(event) => onManualTranscriptChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); onInjectManual(); } }} placeholder="Type the words you just spoke..." />
                  <button type="button" onClick={onInjectManual}>Inject Transcript</button>
                </div>
              )}
            </details>

            {/* Mock Playback - default collapsed */}
            <details open={!sectionsCollapsed.mock} onToggle={() => {}} style={{marginBottom:'4px'}}>
              <summary style={{cursor:'pointer'}} onClick={(e) => { e.preventDefault(); toggleSection('mock'); }}>Mock Playback {sectionsCollapsed.mock ? '▶' : '▼'}</summary>
              {!sectionsCollapsed.mock && (
                <div>
                  <textarea className="mock-input" value={mockScript} onChange={(event) => onMockScriptChange(event.target.value)} spellCheck={false} />
                  <div className="inline-actions">
                    <button type="button" onClick={onPlayMock} disabled={isMockPlaying}>Play Mock</button>
                    <button type="button" onClick={onStopMock} disabled={!isMockPlaying}>Stop Mock</button>
                  </div>
                </div>
              )}
            </details>

            <TortureTestPanel model={model} currentTokenIndex={currentTokenIndex} onLoadManuscript={onManuscriptTextChange} />

            {/* Search */}
            <details open={!sectionsCollapsed.search} onToggle={() => {}} style={{marginBottom:'4px'}}>
              <summary style={{cursor:'pointer'}} onClick={(e) => { e.preventDefault(); toggleSection('search'); }}>Search {sectionsCollapsed.search ? '▶' : '▼'}</summary>
              {!sectionsCollapsed.search && (
                <div className="search-row">
                  <input id="manuscript-search" value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSearchJump(); }} placeholder="Find phrase" />
                  <button type="button" onClick={onSearchJump}>Jump</button>
                </div>
              )}
            </details>

            {/* Display - default collapsed to reduce clutter (per req, not in basic visible list) */}
            <details open={!sectionsCollapsed.display} onToggle={() => {}} style={{marginBottom:'4px'}}>
              <summary style={{cursor:'pointer'}} onClick={(e) => { e.preventDefault(); toggleSection('display'); }}>Display {sectionsCollapsed.display ? '▶' : '▼'}</summary>
              {!sectionsCollapsed.display && (
                <div>
                  <div className="settings-grid">
                    <label>Font <input type="number" min={22} max={78} value={settings.fontSizePx} onChange={(event) => onSettingsChange({ ...settings, fontSizePx: Number(event.target.value) })} /></label>
                    <label>Line <input type="number" min={1.1} max={2.2} step={0.05} value={settings.lineHeight} onChange={(event) => onSettingsChange({ ...settings, lineHeight: Number(event.target.value) })} /></label>
                    <label>Width <input type="number" min={42} max={92} value={settings.textWidthCh} onChange={(event) => onSettingsChange({ ...settings, textWidthCh: Number(event.target.value) })} /></label>
                    <label>Zone <input type="number" min={45} max={75} value={settings.readingZonePercent} onChange={(event) => onSettingsChange({ ...settings, readingZonePercent: Number(event.target.value) })} /></label>
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => onSettingsChange({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}>{settings.theme === 'dark' ? 'Light' : 'Dark'}</button>
                    <button type="button" onClick={onToggleAlwaysOnTop}>Top</button>
                    <button type="button" onClick={onToggleDebug}>{debugVisible ? 'Hide Debug' : 'Debug'}</button>
                  </div>
                </div>
              )}
            </details>

            {/* Shortcuts - default collapsed */}
            <details open={!sectionsCollapsed.shortcuts} onToggle={() => {}}>
              <summary style={{cursor:'pointer'}} onClick={(e) => { e.preventDefault(); toggleSection('shortcuts'); }}>Shortcuts {sectionsCollapsed.shortcuts ? '▶' : '▼'}</summary>
              {!sectionsCollapsed.shortcuts && <ShortcutHelp />}
            </details>

            {/* Raw Trace / Debug area - moved here, Debug button already above; trace labeled Alignment Trace in DebugPanel */}
          </div>
        )}
      </section>

      {/* The DebugPanel (contains Alignment Trace etc) is rendered here; its visibility is controlled by the "Debug" button now inside Developer Tools above. Trace inside is the raw one. */}
      <DebugPanel
        visible={debugVisible}
        deltas={deltas}
        transcriptBuffer={transcriptBuffer}
        alignment={alignment}
        currentTokenIndex={currentTokenIndex}
        followState={followState}
        traceLog={traceLog}
      />
    </aside>
  );
}
