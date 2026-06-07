import type { NarrationStatus } from '../domain/narrationStatus';

type Props = {
  status: NarrationStatus;
  providerLabel: string;
  isRunning: boolean;
  inputLevel: number;
  controlsVisible: boolean;
  startStopDisabled: boolean;
  onStartStop(): void;
  onToggleControls(): void;
};

export function NarrationBar({
  status,
  providerLabel,
  isRunning,
  inputLevel,
  controlsVisible,
  startStopDisabled,
  onStartStop,
  onToggleControls
}: Props) {
  return (
    <div className={`narration-bar narration-${status.tone}`}>
      <button
        className="narration-primary"
        type="button"
        onClick={onStartStop}
        disabled={startStopDisabled}
      >
        {isRunning ? 'Stop' : 'Start'}
      </button>
      <div className="narration-status">
        <strong>{status.label}</strong>
        <span>{providerLabel}</span>
      </div>
      <div className="narration-meter" aria-label="Microphone level">
        <div style={{ width: `${Math.round(Math.max(0, Math.min(1, inputLevel)) * 100)}%` }} />
      </div>
      <div className="narration-warning-text" title={status.warning ?? ''}>
        {status.warning ?? ''}
      </div>
      <button type="button" onClick={onToggleControls}>
        {controlsVisible ? 'Hide Controls' : 'Controls'}
      </button>
    </div>
  );
}
