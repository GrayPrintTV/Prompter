import { describe, expect, it } from 'vitest';
import { LocalWhisperTelemetryAccumulator } from '../diagnostics/LocalWhisperTelemetry';
import type { LocalWhisperTranscriptTelemetry } from '../domain/types';

function telemetry(overrides: Partial<LocalWhisperTranscriptTelemetry> = {}): LocalWhisperTranscriptTelemetry {
  return {
    requestId: 'request-1',
    capturedAtMs: 1_000,
    audioDurationMs: 2_000,
    rendererDispatchedAtMs: 3_500,
    mainReceivedAtMs: 3_510,
    mainDispatchedAtMs: 3_550,
    sidecarStartedAtMs: 3_600,
    sidecarInferenceMs: 100,
    mainCompletedAtMs: 3_700,
    rendererReceivedAtMs: 3_720,
    mainQueueDepthAtReceive: 0,
    mainQueueDepthAtDispatch: 1,
    mainQueueDepthAtCompletion: 0,
    ...overrides
  };
}

describe('LocalWhisperTelemetryAccumulator', () => {
  it('aggregates stage percentiles, queue depths, result classes, and status transitions', () => {
    let nowMs = 1_000;
    const accumulator = new LocalWhisperTelemetryAccumulator(() => nowMs);
    accumulator.recordProviderEvent({ type: 'chunk-captured', audioDurationSeconds: 2, queueDepth: 0 });
    accumulator.recordProviderEvent({ type: 'queue-depth', queueDepth: 3 });
    accumulator.recordProviderEvent({ type: 'result', telemetry: telemetry(), empty: false });
    accumulator.recordProviderEvent({
      type: 'result',
      telemetry: telemetry({
        requestId: 'request-2',
        rendererDispatchedAtMs: 4_000,
        mainDispatchedAtMs: 3_610,
        sidecarStartedAtMs: 3_800,
        sidecarInferenceMs: 400,
        rendererReceivedAtMs: 4_500,
        mainQueueDepthAtReceive: 1,
        mainQueueDepthAtDispatch: 2,
        mainQueueDepthAtCompletion: 1
      }),
      empty: true
    });
    accumulator.recordProviderEvent({ type: 'generation-fenced' });
    accumulator.recordCoordinatorResult({
      telemetry: telemetry(),
      acceptedAtMs: 3_730,
      rejectedAsStale: false,
      alignmentAccepted: true,
      visibleMovementExpected: true
    });
    accumulator.recordVisibleMovement(3_750);
    accumulator.recordCoordinatorResult({
      acceptedAtMs: 4_600,
      rejectedAsStale: true,
      alignmentAccepted: false,
      visibleMovementExpected: false
    });
    accumulator.recordCoordinatorResult({
      acceptedAtMs: 4_700,
      rejectedAsStale: false,
      alignmentAccepted: false,
      visibleMovementExpected: false,
      rejection: {
        category: 'stale-context', currentTokenIndex: 24, candidateStartTokenIndex: 12, candidateEndTokenIndex: 24,
        confidence: 0.91, matchedWordCount: 0, distinctiveMatchedWordCount: 0, lowConfidenceCount: 2,
        followState: 'holding', transcriptAgeMs: 3_700, rendererBacklogMs: 500
      }
    });
    accumulator.recordNarratorStatus('Following');
    accumulator.recordNarratorStatus('Stalled');
    accumulator.recordNarratorStatus('Recovering');
    nowMs = 61_000;

    const aggregate = accumulator.drain();

    expect(aggregate).toMatchObject({
      windowDurationMs: 60_000,
      counts: {
        chunksCaptured: 1,
        transcriptionResults: 2,
        emptyResults: 1,
        rejectedAsStale: 1,
        generationFenced: 1,
        alignmentUnaccepted: 1,
        coordinatorAccepted: 1,
        visibleMovements: 1,
        visibleMovementPending: 0
      },
      queueDepth: {
        renderer: { current: 3, max: 3 },
        main: { current: 1, max: 2 }
      },
      audioDurationProcessedSeconds: 4,
      narratorStatusTransitions: {
        total: 2,
        byTransition: { 'Following->Stalled': 1, 'Stalled->Recovering': 1 }
      }
    });
    expect(aggregate?.latencyMs.rendererAudioBacklog).toEqual({ count: 2, p50: 1_000, p90: 1_000, max: 1_000 });
    expect(aggregate?.latencyMs.mainProcessQueueWait).toEqual({ count: 2, p50: 100, p90: 100, max: 100 });
    expect(aggregate?.latencyMs.sidecarCommandQueueWait).toEqual({ count: 2, p50: 190, p90: 190, max: 190 });
    expect(aggregate?.latencyMs.sidecarInference).toEqual({ count: 2, p50: 400, p90: 400, max: 400 });
    expect(aggregate?.latencyMs.captureToTranscript).toEqual({ count: 2, p50: 3_500, p90: 3_500, max: 3_500 });
    expect(aggregate?.latencyMs.transcriptToCoordinatorAcceptance).toEqual({ count: 1, p50: 10, p90: 10, max: 10 });
    expect(aggregate?.latencyMs.coordinatorToVisibleMovement).toEqual({ count: 1, p50: 20, p90: 20, max: 20 });
    expect(aggregate).toMatchObject({
      schemaVersion: 2,
      alignmentRejections: {
        byCategory: { 'stale-context': 1 },
        samples: [expect.objectContaining({ category: 'stale-context', currentTokenIndex: 24, confidence: 0.91 })],
        droppedSamples: 0
      }
    });
  });

  it('bounds retained latency samples and resets each emitted window', () => {
    const accumulator = new LocalWhisperTelemetryAccumulator(() => 0);
    for (let index = 0; index < 400; index += 1) {
      accumulator.recordProviderEvent({
        type: 'result',
        telemetry: telemetry({ requestId: String(index), sidecarInferenceMs: index }),
        empty: false
      });
    }

    expect(accumulator.sampleCount('sidecarInference')).toBe(256);
    expect(accumulator.drain(60_000)?.latencyMs.sidecarInference).toEqual({
      count: 256,
      p50: 272,
      p90: 374,
      max: 399
    });
    expect(accumulator.sampleCount('sidecarInference')).toBe(0);
    expect(accumulator.drain(120_000)).toBeNull();
  });

  it('expires and explicitly resets lifecycle-only correlations', () => {
    let nowMs = 1_000;
    const accumulator = new LocalWhisperTelemetryAccumulator(() => nowMs);
    accumulator.recordProviderEvent({ type: 'chunk-captured', audioDurationSeconds: 2, queueDepth: 0 });
    accumulator.recordCoordinatorResult({
      acceptedAtMs: nowMs,
      rejectedAsStale: false,
      alignmentAccepted: true,
      visibleMovementExpected: true
    });
    nowMs += 10_001;
    expect(accumulator.drain()?.counts.visibleMovementPending).toBe(0);

    accumulator.recordNarratorStatus('Following');
    accumulator.resetLifecycleCorrelations();
    accumulator.recordNarratorStatus('Listening');
    nowMs += 1;
    accumulator.recordProviderEvent({ type: 'chunk-captured', audioDurationSeconds: 2, queueDepth: 0 });
    expect(accumulator.drain()?.narratorStatusTransitions.total).toBe(0);
  });

  it('counts every rejection while retaining only bounded, text-free samples', () => {
    const accumulator = new LocalWhisperTelemetryAccumulator(() => 0);
    for (let index = 0; index < 40; index += 1) {
      accumulator.recordCoordinatorResult({
        acceptedAtMs: index,
        rejectedAsStale: false,
        alignmentAccepted: false,
        visibleMovementExpected: false,
        rejection: {
          category: 'low-confidence', currentTokenIndex: index, candidateStartTokenIndex: null, candidateEndTokenIndex: null,
          confidence: 0.2, matchedWordCount: 1, distinctiveMatchedWordCount: 0, lowConfidenceCount: index,
          followState: 'holding', transcriptAgeMs: 2_000, rendererBacklogMs: 100
        }
      });
    }
    const aggregate = accumulator.drain(60_000)!;
    expect(aggregate.alignmentRejections).toMatchObject({
      byCategory: { 'low-confidence': 40 }, droppedSamples: 8
    });
    expect(aggregate.alignmentRejections?.samples).toHaveLength(32);
    expect(JSON.stringify(aggregate.alignmentRejections)).not.toContain('recognized speech');
  });
});
