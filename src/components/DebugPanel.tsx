import type { AlignmentBufferDebug, AlignmentResult, FollowState, TranscriptDelta } from '../domain/types';

type Props = {
  visible: boolean;
  deltas: TranscriptDelta[];
  transcriptBuffer: string[];
  alignment: AlignmentResult;
  currentTokenIndex: number;
  followState: FollowState;
  alignmentBufferDebug?: AlignmentBufferDebug;
  traceLog?: string[];
};

export function DebugPanel({
  visible,
  deltas,
  transcriptBuffer,
  alignment,
  currentTokenIndex,
  followState,
  alignmentBufferDebug,
  traceLog
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
        <dt>Current token (precise anchor)</dt>
        <dd>{currentTokenIndex} (sentence {alignment.sentenceIndex})</dd>
        <dt>Anchor / Best match</dt>
        <dd>{alignment.matchedText || 'None'} (use for band target + pace)</dd>
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
        <dt>Delta tokens</dt>
        <dd>{alignmentBufferDebug?.normalizedTokens.join(' ') || 'Empty'}</dd>
        <dt>Retained tokens</dt>
        <dd>{alignmentBufferDebug?.retainedTokens.join(' ') || 'Empty'}</dd>
        <dt>Evidence buffer</dt>
        <dd>{alignmentBufferDebug?.rollingBufferTokens.join(' ') || 'Empty'}</dd>
        <dt>Provisional buffer</dt>
        <dd>{alignmentBufferDebug?.provisionalBufferTokens.join(' ') || 'Empty'}</dd>
        <dt>Evaluation buffer</dt>
        <dd>{alignmentBufferDebug?.evaluationBufferTokens.join(' ') || 'Empty'}</dd>
        <dt>Context decision</dt>
        <dd>
          {alignmentBufferDebug
            ? `${alignmentBufferDebug.retentionDecision}: ${alignmentBufferDebug.retentionReason}`
            : 'None'}
        </dd>
        <dt>Move decision</dt>
        <dd>
          {alignmentBufferDebug
            ? `${alignmentBufferDebug.moveToTokenCalled ? 'moveToToken called' : 'moveToToken not called'}; ${alignmentBufferDebug.moveDecision}`
            : 'None'}
        </dd>
        <dt>Alignment Trace (raw/norm/match/conf/action/scroll; collapsed by default in dev tools)</dt>
        <dd>
          {traceLog && traceLog.length ? (
            traceLog.slice(-16).map((entry, i) => (
              <div key={i} style={{ fontFamily: 'monospace', fontSize: '10px', lineHeight: '1.2' }}>{entry}</div>
            ))
          ) : '—'}
        </dd>
      </dl>
    </section>
  );
}
