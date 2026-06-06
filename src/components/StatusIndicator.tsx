import type { FollowState } from '../domain/types';

type Props = {
  state: FollowState;
  confidence: number;
  isListening: boolean;
};

const LABELS: Record<FollowState, string> = {
  manual: 'Manual',
  paused: 'Paused',
  following: 'Following',
  holding: 'Holding',
  uncertain: 'Uncertain',
  lost: 'Lost',
  resyncing: 'Resyncing',
  retake: 'Retake'
};

export function StatusIndicator({ state, confidence, isListening }: Props) {
  return (
    <div className={`status-indicator state-${state}`}>
      <div>
        <span className="status-label">{LABELS[state]}</span>
        <span className="status-subtle">{isListening ? 'ASR armed' : 'ASR idle'}</span>
      </div>
      <div className="confidence-readout">
        <span>{Math.round(confidence * 100)}%</span>
        <div className="confidence-bar">
          <div style={{ width: `${Math.round(confidence * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}
