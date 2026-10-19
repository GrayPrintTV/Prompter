import type {
  AlignmentRejectionCategory,
  LocalWhisperTelemetryAggregate,
  LocalWhisperAlignmentRejectionSample,
  LocalWhisperTranscriptTelemetry
} from '../domain/types';
import type { NarrationStatusLabel } from '../domain/narrationStatus';

const MAX_STAGE_SAMPLES = 256;
const MAX_VISIBLE_MOVEMENT_WAIT_MS = 10_000;
const MAX_REJECTION_SAMPLES = 32;

type StageName = keyof LocalWhisperTelemetryAggregate['latencyMs'];

export type LocalWhisperProviderTelemetryEvent =
  | { type: 'chunk-captured'; audioDurationSeconds: number; queueDepth: number }
  | { type: 'queue-depth'; queueDepth: number }
  | { type: 'generation-fenced' }
  | { type: 'result'; telemetry: LocalWhisperTranscriptTelemetry; empty: boolean };

type Counts = LocalWhisperTelemetryAggregate['counts'];

function emptyCounts(): Counts {
  return {
    chunksCaptured: 0,
    transcriptionResults: 0,
    emptyResults: 0,
    rejectedAsStale: 0,
    generationFenced: 0,
    alignmentUnaccepted: 0,
    coordinatorAccepted: 0,
    visibleMovements: 0,
    visibleMovementPending: 0
  };
}

function percentileSummary(values: number[]) {
  if (values.length === 0) return { count: 0, p50: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percentile: number) => sorted[Math.ceil((sorted.length - 1) * percentile)];
  return {
    count: sorted.length,
    p50: Math.round(at(0.5)),
    p90: Math.round(at(0.9)),
    max: Math.round(sorted[sorted.length - 1])
  };
}

export class LocalWhisperTelemetryAccumulator {
  private windowStartedAtMs: number;
  private counts = emptyCounts();
  private rendererQueueCurrent = 0;
  private rendererQueueMax = 0;
  private mainQueueCurrent = 0;
  private mainQueueMax = 0;
  private audioDurationProcessedSeconds = 0;
  private readonly samples: Record<StageName, number[]> = {
    rendererAudioBacklog: [],
    mainProcessQueueWait: [],
    sidecarCommandQueueWait: [],
    sidecarInference: [],
    captureToTranscript: [],
    transcriptToCoordinatorAcceptance: [],
    coordinatorToVisibleMovement: []
  };
  private lastNarratorStatus: NarrationStatusLabel | null = null;
  private statusTransitionTotal = 0;
  private statusTransitions: Record<string, number> = {};
  private pendingVisibleMovementAtMs: number | null = null;
  private rejectionCounts: Partial<Record<AlignmentRejectionCategory, number>> = {};
  private rejectionSamples: LocalWhisperAlignmentRejectionSample[] = [];
  private droppedRejectionSamples = 0;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.windowStartedAtMs = now();
  }

  recordProviderEvent(event: LocalWhisperProviderTelemetryEvent) {
    if (event.type === 'chunk-captured') {
      this.counts.chunksCaptured += 1;
      this.recordRendererQueueDepth(event.queueDepth);
      return;
    }
    if (event.type === 'queue-depth') {
      this.recordRendererQueueDepth(event.queueDepth);
      return;
    }
    if (event.type === 'generation-fenced') {
      this.counts.generationFenced += 1;
      return;
    }

    const telemetry = event.telemetry;
    this.counts.transcriptionResults += 1;
    if (event.empty) this.counts.emptyResults += 1;
    this.audioDurationProcessedSeconds += Math.max(0, telemetry.audioDurationMs) / 1000;
    const audioReadyAtMs = telemetry.capturedAtMs + Math.max(0, telemetry.audioDurationMs);
    this.addSample('rendererAudioBacklog', telemetry.rendererDispatchedAtMs - audioReadyAtMs);
    this.addSample('mainProcessQueueWait', telemetry.mainDispatchedAtMs - telemetry.mainReceivedAtMs);
    if (telemetry.sidecarStartedAtMs !== undefined) {
      this.addSample('sidecarCommandQueueWait', telemetry.sidecarStartedAtMs - telemetry.mainDispatchedAtMs);
    }
    if (telemetry.sidecarInferenceMs !== undefined) {
      this.addSample('sidecarInference', telemetry.sidecarInferenceMs);
    }
    this.addSample('captureToTranscript', telemetry.rendererReceivedAtMs - telemetry.capturedAtMs);
    this.mainQueueCurrent = Math.max(0, telemetry.mainQueueDepthAtCompletion);
    this.mainQueueMax = Math.max(
      this.mainQueueMax,
      telemetry.mainQueueDepthAtReceive,
      telemetry.mainQueueDepthAtDispatch
    );
  }

  recordCoordinatorResult(params: {
    telemetry?: LocalWhisperTranscriptTelemetry;
    acceptedAtMs: number;
    rejectedAsStale: boolean;
    alignmentAccepted: boolean;
    visibleMovementExpected: boolean;
    rejection?: LocalWhisperAlignmentRejectionSample;
  }) {
    if (params.telemetry) {
      this.addSample(
        'transcriptToCoordinatorAcceptance',
        params.acceptedAtMs - params.telemetry.rendererReceivedAtMs
      );
    }
    if (params.rejectedAsStale) this.counts.rejectedAsStale += 1;
    if (params.alignmentAccepted) this.counts.coordinatorAccepted += 1;
    else {
      if (!params.rejectedAsStale) this.counts.alignmentUnaccepted += 1;
      if (params.rejection) this.recordRejection(params.rejection);
    }
    if (params.visibleMovementExpected) this.pendingVisibleMovementAtMs = params.acceptedAtMs;
  }

  recordVisibleMovement(visibleAtMs = this.now()) {
    const pendingAtMs = this.pendingVisibleMovementAtMs;
    if (pendingAtMs === null) return;
    this.pendingVisibleMovementAtMs = null;
    const delayMs = visibleAtMs - pendingAtMs;
    if (delayMs < 0 || delayMs > MAX_VISIBLE_MOVEMENT_WAIT_MS) return;
    this.addSample('coordinatorToVisibleMovement', delayMs);
    this.counts.visibleMovements += 1;
  }

  recordNarratorStatus(status: NarrationStatusLabel) {
    const previous = this.lastNarratorStatus;
    this.lastNarratorStatus = status;
    if (!previous || previous === status) return;
    const key = `${previous}->${status}`;
    this.statusTransitions[key] = (this.statusTransitions[key] ?? 0) + 1;
    this.statusTransitionTotal += 1;
  }

  resetLifecycleCorrelations() {
    this.pendingVisibleMovementAtMs = null;
    this.lastNarratorStatus = null;
  }

  drain(nowMs = this.now()): LocalWhisperTelemetryAggregate | null {
    if (
      this.pendingVisibleMovementAtMs !== null &&
      nowMs - this.pendingVisibleMovementAtMs > MAX_VISIBLE_MOVEMENT_WAIT_MS
    ) {
      this.pendingVisibleMovementAtMs = null;
    }
    const hasActivity =
      this.counts.chunksCaptured > 0 ||
      this.counts.generationFenced > 0 ||
      this.statusTransitionTotal > 0 ||
      this.rejectionSamples.length > 0 ||
      Object.keys(this.rejectionCounts).length > 0 ||
      Object.values(this.samples).some((values) => values.length > 0);
    if (!hasActivity) {
      this.windowStartedAtMs = nowMs;
      return null;
    }

    const aggregate: LocalWhisperTelemetryAggregate = {
      schemaVersion: 2,
      windowStartedAtMs: this.windowStartedAtMs,
      windowEndedAtMs: nowMs,
      windowDurationMs: Math.max(0, nowMs - this.windowStartedAtMs),
      counts: {
        ...this.counts,
        visibleMovementPending: this.pendingVisibleMovementAtMs === null ? 0 : 1
      },
      queueDepth: {
        renderer: { current: this.rendererQueueCurrent, max: this.rendererQueueMax },
        main: { current: this.mainQueueCurrent, max: this.mainQueueMax }
      },
      audioDurationProcessedSeconds: Math.round(this.audioDurationProcessedSeconds * 100) / 100,
      latencyMs: {
        rendererAudioBacklog: percentileSummary(this.samples.rendererAudioBacklog),
        mainProcessQueueWait: percentileSummary(this.samples.mainProcessQueueWait),
        sidecarCommandQueueWait: percentileSummary(this.samples.sidecarCommandQueueWait),
        sidecarInference: percentileSummary(this.samples.sidecarInference),
        captureToTranscript: percentileSummary(this.samples.captureToTranscript),
        transcriptToCoordinatorAcceptance: percentileSummary(this.samples.transcriptToCoordinatorAcceptance),
        coordinatorToVisibleMovement: percentileSummary(this.samples.coordinatorToVisibleMovement)
      },
      narratorStatusTransitions: {
        total: this.statusTransitionTotal,
        byTransition: { ...this.statusTransitions }
      },
      alignmentRejections: {
        byCategory: { ...this.rejectionCounts },
        samples: this.rejectionSamples.map((sample) => ({ ...sample })),
        droppedSamples: this.droppedRejectionSamples
      },
      measurementNotes: [
        'rendererAudioBacklog starts when a complete audio chunk is ready, not when its first sample was captured',
        'mainProcessQueueWait covers main IPC receipt through sidecar command dispatch, including temp-file preparation',
        'sidecarCommandQueueWait uses wall-clock timestamps on the same Windows host',
        'captureToTranscript starts at the first sample in the audio chunk and ends when its transcript reaches the renderer',
        'coordinatorToVisibleMovement is sampled only for discrete programmatic scroll writes; compositor paint and Assist cruise are not observable'
      ]
    };
    this.resetWindow(nowMs);
    return aggregate;
  }

  sampleCount(stage: StageName) {
    return this.samples[stage].length;
  }

  private recordRejection(sample: LocalWhisperAlignmentRejectionSample) {
    this.rejectionCounts[sample.category] = (this.rejectionCounts[sample.category] ?? 0) + 1;
    if (this.rejectionSamples.length >= MAX_REJECTION_SAMPLES) {
      this.droppedRejectionSamples += 1;
      return;
    }
    this.rejectionSamples.push({ ...sample });
  }

  private recordRendererQueueDepth(queueDepth: number) {
    const boundedDepth = Math.max(0, Math.round(queueDepth));
    this.rendererQueueCurrent = boundedDepth;
    this.rendererQueueMax = Math.max(this.rendererQueueMax, boundedDepth);
  }

  private addSample(stage: StageName, value: number) {
    if (!Number.isFinite(value)) return;
    const values = this.samples[stage];
    values.push(Math.max(0, value));
    if (values.length > MAX_STAGE_SAMPLES) values.splice(0, values.length - MAX_STAGE_SAMPLES);
  }

  private resetWindow(nowMs: number) {
    this.windowStartedAtMs = nowMs;
    this.counts = emptyCounts();
    this.rendererQueueMax = this.rendererQueueCurrent;
    this.mainQueueMax = this.mainQueueCurrent;
    this.audioDurationProcessedSeconds = 0;
    for (const values of Object.values(this.samples)) values.length = 0;
    this.statusTransitionTotal = 0;
    this.statusTransitions = {};
    this.rejectionCounts = {};
    this.rejectionSamples = [];
    this.droppedRejectionSamples = 0;
  }
}
