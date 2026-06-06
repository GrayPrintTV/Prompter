import type { AlignmentResult, FollowState, TranscriptDelta } from '../domain/types';

type Props = {
  visible: boolean;
  deltas: TranscriptDelta[];
  transcriptBuffer: string[];
  alignment: AlignmentResult;
  currentTokenIndex: number;
  followState: FollowState;
};

export function DebugPanel({
  visible,
  deltas,
  transcriptBuffer,
  alignment,
  currentTokenIndex,
  followState
}: Props) {
  if (!visible) return null;

  const lastDelta = deltas[deltas.length - 1];

  return (
    <section className="panel-section debug-panel">
      <h2>Debug</h2>
      <dl>
        <dt>Last delta</dt>
        <dd>{lastDelta ? `${lastDelta.source}: ${lastDelta.text || '[pause]'}` : 'None'}</dd>
        <dt>Rolling buffer</dt>
        <dd>{transcriptBuffer.join(' ') || 'Empty'}</dd>
        <dt>Current token</dt>
        <dd>{currentTokenIndex}</dd>
        <dt>Best match</dt>
        <dd>{alignment.matchedText || 'None'}</dd>
        <dt>Confidence</dt>
        <dd>{alignment.confidence.toFixed(3)}</dd>
        <dt>Follow state</dt>
        <dd>{followState}</dd>
        <dt>Search window</dt>
        <dd>
          {alignment.searchWindow.fromToken} - {alignment.searchWindow.toToken}
        </dd>
        <dt>Reason</dt>
        <dd>{alignment.reason}</dd>
      </dl>
    </section>
  );
}
