import { useEffect, useRef } from 'react';
import {
  DEFAULT_ASSIST_STALE_SLOW_MS,
  DEFAULT_ASSIST_STALE_STOP_MS,
  DEFAULT_SCROLL_DEADBAND_PX,
  assistSpeedToLinesPerMinute,
  assistSpeedToVelocityPxPerMs,
  computeAssistCruiseStep,
  computeAssistTargetVelocity,
  computeCorrectionAnimationPlan,
  computePrompterScrollTarget,
  computeRenderedLineCenterY,
  computeReadingZoneGeometry,
  estimateAssistVelocityFromAnchors,
  interpolateCorrectionScroll,
  isAnchorNearReadingTarget,
  type CorrectionAnimationPlan,
  type ReadingZoneGeometry
} from '../domain/prompterScroll';
import {
  nearestVisibleTokenIndex,
  type VisibleReacquireSource
} from '../domain/manualFollow';
import type { AssistStatusInfo } from '../domain/types';
import { HIGH_CONFIDENCE, shouldScrollForState } from '../domain/scrollModel';
import type {
  DisplaySettings,
  FollowState,
  ManuscriptModel,
  ScrollAnimationStatusInfo,
  ScrollTestRequest
} from '../domain/types';

type Props = {
  model: ManuscriptModel;
  currentSentenceIndex: number;
  currentTokenIndex?: number;
  followState: FollowState;
  confidence: number;
  settings: DisplaySettings;
  layoutMode?: 'with-controls' | 'prompter-only';
  assistScrollLagging?: boolean;
  scrollTestRequest?: ScrollTestRequest | null;
  onTraceScroll?: (info: { sentenceIndex: number; didScroll: boolean; reason: string }) => void;
  onAssistStatus?: (info: AssistStatusInfo) => void;
  onScrollAnimationStatus?: (info: ScrollAnimationStatusInfo) => void;
  manualScrollTrackingEnabled?: boolean;
  visibleReacquireActive?: boolean;
  visibleReacquireSource?: VisibleReacquireSource;
  startupVisibleAnchorRequestId?: number;
  onStartupVisibleAnchor?: (info: {
    requestId: number;
    visibleTokenIndex: number;
    scrollTop: number;
  }) => void;
  onManualScroll?: (info: {
    visibleTokenIndex: number;
    scrollTop: number;
    direction: 'backward' | 'forward' | 'stationary';
  }) => void;
  onAnchorDebug?: (info: {
    confirmedToken: number;
    targetToken: number;
    lookahead: number;
    distLines: number;
    decision: string;
    bandH: number;
    bandHeightLines: number;
    lineH: number;
    targetY: number;
    targetOffsetPx: number;
    targetOffsetLines: number;
    toleranceZoneH: number;
  }) => void;
};

function visibleTokenAtReadingBand(
  container: HTMLDivElement,
  geometry: ReadingZoneGeometry
) {
  const containerRect = container.getBoundingClientRect();
  const positions = Array.from(
    container.querySelectorAll<HTMLElement>('[data-token-index]')
  ).map((element) => {
    const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
    return {
      tokenIndex: Number(element.dataset.tokenIndex),
      topInViewport: computeRenderedLineCenterY(rect.top - containerRect.top, rect.height)
    };
  });
  return nearestVisibleTokenIndex(positions, geometry.targetY);
}

export function PrompterView({
  model,
  currentSentenceIndex,
  currentTokenIndex,
  followState,
  confidence,
  settings,
  layoutMode = 'with-controls',
  assistScrollLagging = false,
  scrollTestRequest,
  onTraceScroll,
  onAssistStatus,
  onScrollAnimationStatus,
  manualScrollTrackingEnabled = false,
  visibleReacquireActive = false,
  visibleReacquireSource,
  startupVisibleAnchorRequestId = 0,
  onStartupVisibleAnchor,
  onManualScroll,
  onAnchorDebug
}: Props) {
  const paneRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const geometryRef = useRef<ReadingZoneGeometry | null>(null);
  const reduceMotionRef = useRef(false);
  const animationRef = useRef<{
    active: boolean;
    frameId: number | null;
    startTimestamp: number | null;
    plan: CorrectionAnimationPlan | null;
    sentenceIndex: number;
    source: 'live' | 'test';
    resumeCruiseOnComplete: boolean;
    id: number;
    frameCount: number;
  }>({
    active: false,
    frameId: null,
    startTimestamp: null,
    plan: null,
    sentenceIndex: -1,
    source: 'live',
    resumeCruiseOnComplete: true,
    id: 0,
    frameCount: 0
  });
  const cruiseRef = useRef<{
    frameId: number | null;
    lastTimestamp: number | null;
    sentenceIndex: number;
    velocityPxPerMs: number;
    slowed: boolean;
  }>({
    frameId: null,
    lastTimestamp: null,
    sentenceIndex: -1,
    velocityPxPerMs: 0,
    slowed: false
  });
  const assistAnchorRef = useRef<{
    lastConfirmedAt: number;
    lastTargetScrollTop: number;
    lastSentenceIndex: number;
    estimatedVelocityPxPerMs: number;
  }>({
    lastConfirmedAt: 0,
    lastTargetScrollTop: 0,
    lastSentenceIndex: -1,
    estimatedVelocityPxPerMs: 0
  });
  const lastProgrammaticScrollRef = useRef<{ scrollTop: number; timestampMs: number } | null>(null);
  const manualScrollIntentUntilRef = useRef(0);
  const manualScrollDebounceRef = useRef<number | null>(null);
  const lastObservedScrollTopRef = useRef(0);
  const pendingManualDirectionRef = useRef<'backward' | 'forward' | 'stationary'>('stationary');
  const manualScrollHoldRef = useRef(false);
  const lastStartupVisibleAnchorRequestRef = useRef(0);
  const latestMotionRef = useRef({
    followState,
    confidence,
    continuousAssistScroll: settings.continuousAssistScroll,
    assistScrollSpeed: settings.assistScrollSpeed,
    assistCorrectionFeel: settings.assistCorrectionFeel,
    readingLookaheadTokens: settings.readingLookaheadTokens,
    assistScrollLagging,
    manualScrollTrackingEnabled,
    visibleReacquireActive
  });

  // Store latest callback in ref so we can call it without including the (possibly unstable) callback
  // in the main scroll effect's dependency array. This prevents parent state updates from retriggering
  // the effect via prop identity.
  const onTraceScrollRef = useRef(onTraceScroll);
  const onAssistStatusRef = useRef(onAssistStatus);
  const onScrollAnimationStatusRef = useRef(onScrollAnimationStatus);
  const onStartupVisibleAnchorRef = useRef(onStartupVisibleAnchor);
  const onManualScrollRef = useRef(onManualScroll);
  const onAnchorDebugRef = useRef(onAnchorDebug);

  useEffect(() => {
    onTraceScrollRef.current = onTraceScroll;
  }, [onTraceScroll]);

  useEffect(() => {
    onAssistStatusRef.current = onAssistStatus;
  }, [onAssistStatus]);

  useEffect(() => {
    onScrollAnimationStatusRef.current = onScrollAnimationStatus;
  }, [onScrollAnimationStatus]);

  useEffect(() => {
    onStartupVisibleAnchorRef.current = onStartupVisibleAnchor;
  }, [onStartupVisibleAnchor]);

  useEffect(() => {
    onManualScrollRef.current = onManualScroll;
  }, [onManualScroll]);

  useEffect(() => {
    onAnchorDebugRef.current = onAnchorDebug;
  }, [onAnchorDebug]);

  useEffect(() => {
    latestMotionRef.current = {
      followState,
      confidence,
      continuousAssistScroll: settings.continuousAssistScroll,
      assistScrollSpeed: settings.assistScrollSpeed,
      assistCorrectionFeel: settings.assistCorrectionFeel,
      readingLookaheadTokens: settings.readingLookaheadTokens,
      assistScrollLagging,
      manualScrollTrackingEnabled,
      visibleReacquireActive
    };
  }, [
    assistScrollLagging,
    confidence,
    followState,
    settings.assistCorrectionFeel,
    settings.assistScrollSpeed,
    settings.continuousAssistScroll,
    settings.readingLookaheadTokens,
    manualScrollTrackingEnabled,
    visibleReacquireActive
  ]);

  // Remember last emitted scroll trace key so we only emit when the scroll *decision* actually changes
  // (sentence + followState + confidence bucket + didScroll), not on every effect run or re-render.
  const lastScrollTraceKeyRef = useRef<string | null>(null);
  const lastCruiseTraceMsRef = useRef(0);
  const lastAssistStatusKeyRef = useRef<string | null>(null);
  const lastAssistStatusReportMsRef = useRef(0);

  const lastAnchorDebugKeyRef = useRef<string | null>(null);
  const lastReducedMotionStatusRef = useRef<boolean | null>(null);
  const currentSentenceIndexRef = useRef(currentSentenceIndex);

  useEffect(() => {
    currentSentenceIndexRef.current = currentSentenceIndex;
  }, [currentSentenceIndex]);

  const emitTrace = (sentenceIndex: number, didScroll: boolean, reason: string, targetScrollTop?: number) => {
    const confBucket = Math.floor(confidence * 100);
    const targetBucket = targetScrollTop === undefined ? 'none' : Math.round(targetScrollTop / 4);
    const key = `${reason}|${sentenceIndex}|${followState}|${confBucket}|${didScroll ? 1 : 0}|${targetBucket}`;
    if (key !== lastScrollTraceKeyRef.current) {
      lastScrollTraceKeyRef.current = key;
      onTraceScrollRef.current?.({ sentenceIndex, didScroll, reason });
    }
  };

  const reportAssistStatus = (state: string, details?: { velocityPxPerSec?: number; pace?: number; reason?: string }) => {
    const latest = latestMotionRef.current;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const pace = assistSpeedToLinesPerMinute(latest.assistScrollSpeed);
    const vel = details?.velocityPxPerSec ?? (cruiseRef.current.velocityPxPerMs * 1000);
    const key = `${state}|${Math.round(vel)}|${Math.round(pace)}|${details?.reason || ''}`;
    if (key === lastAssistStatusKeyRef.current && (now - lastAssistStatusReportMsRef.current) < 350) {
      return; // throttle status updates to avoid update spam / loops
    }
    lastAssistStatusKeyRef.current = key;
    lastAssistStatusReportMsRef.current = now;
    onAssistStatusRef.current?.({
      enabled: !!latest.continuousAssistScroll,
      state,
      reason: details?.reason,
      cruiseVelocityPxPerSec: Math.round(vel),
      estimatedPaceLinesPerMin: Math.round(pace)
    });
  };

  const reportAnimationStatus = (status: string, details: Partial<ScrollAnimationStatusInfo> = {}) => {
    onScrollAnimationStatusRef.current?.({
      reducedMotion: reduceMotionRef.current,
      status,
      ...details
    });
  };

  const writeProgrammaticScrollTop = (container: HTMLDivElement, targetScrollTop: number) => {
    lastProgrammaticScrollRef.current = {
      scrollTop: targetScrollTop,
      timestampMs: window.performance?.now?.() ?? Date.now()
    };
    container.scrollTop = targetScrollTop;
  };

  const planStatusDetails = (plan: CorrectionAnimationPlan): Partial<ScrollAnimationStatusInfo> => ({
    fromScrollTop: plan.fromScrollTop,
    targetScrollTop: plan.targetScrollTop,
    distancePx: plan.distancePx,
    durationMs: plan.durationMs,
    easingCurve: plan.easingCurve,
    correctionFeelPercent: plan.correctionFeelPercent
  });

  const cancelAnimation = (reason?: string) => {
    const animation = animationRef.current;
    const wasActive = animation.active;
    const canceledPlan = animation.plan;
    const sentenceIndex = animation.sentenceIndex;
    const source = animation.source;
    const frameCount = animation.frameCount;
    if (animation.frameId !== null) {
      window.cancelAnimationFrame(animation.frameId);
      animation.frameId = null;
    }
    animation.active = false;
    animation.startTimestamp = null;
    animation.plan = null;
    animation.frameCount = 0;
    animation.id += 1;
    if (reason && wasActive) {
      const diagnostics = canceledPlan ? ` ${formatAnimationPlan(canceledPlan)} frames=${frameCount}` : '';
      emitTrace(
        sentenceIndex >= 0 ? sentenceIndex : currentSentenceIndex,
        false,
        `animation canceled source=${source} reason=${reason}${diagnostics}`,
        canceledPlan?.targetScrollTop
      );
      reportAnimationStatus('canceled', {
        source,
        reason,
        frameCount,
        ...(canceledPlan ? planStatusDetails(canceledPlan) : {})
      });
    }
  };

  const formatAnimationPlan = (plan: CorrectionAnimationPlan) =>
    `from=${plan.fromScrollTop.toFixed(1)} target=${plan.targetScrollTop.toFixed(1)} distance=${plan.distancePx.toFixed(1)} duration=${plan.durationMs}ms easing=${plan.easingCurve} feel=${plan.correctionFeelPercent}`;

  const writeScrollTopDirect = (
    container: HTMLDivElement,
    targetScrollTop: number,
    sentenceIndex: number,
    source: 'live' | 'test',
    reason: string
  ) => {
    const fromScrollTop = container.scrollTop;
    writeProgrammaticScrollTop(container, targetScrollTop);
    const distancePx = Math.abs(targetScrollTop - fromScrollTop);
    emitTrace(
      sentenceIndex,
      true,
      `direct scrollTop write source=${source} reason=${reason} from=${fromScrollTop.toFixed(1)} target=${targetScrollTop.toFixed(1)} distance=${distancePx.toFixed(1)} reducedMotion=${reduceMotionRef.current ? 1 : 0}`,
      targetScrollTop
    );
    reportAnimationStatus('direct scroll', {
      source,
      reason,
      fromScrollTop,
      targetScrollTop,
      distancePx
    });
  };

  const cancelCruise = (reason?: string) => {
    const cruise = cruiseRef.current;
    const sentenceIndex = cruise.sentenceIndex;
    if (cruise.frameId !== null) {
      window.cancelAnimationFrame(cruise.frameId);
      cruise.frameId = null;
    }
    cruise.lastTimestamp = null;
    cruise.velocityPxPerMs = 0;
    cruise.slowed = false;
    if (reason) {
      emitTrace(sentenceIndex >= 0 ? sentenceIndex : currentSentenceIndex, false, reason);
      // Map cruise stop reasons to unambiguous UI status
      let uiState = reason;
      if (reason.includes('disabled')) uiState = 'OFF';
      else if (reason.includes('low confidence')) uiState = 'stopped: low confidence';
      else if (reason.includes('stale confidence')) uiState = 'stopped: stale confidence';
      else if (reason.includes('reduced motion')) uiState = 'stopped: reduced motion';
      else if (reason.includes('assist cruise stopped: ')) uiState = reason.replace('assist cruise stopped: ', 'stopped: ');
      reportAssistStatus(uiState, { velocityPxPerSec: 0, reason });
    } else if (!latestMotionRef.current.continuousAssistScroll) {
      reportAssistStatus('OFF');
    }
  };

  const cruiseStopReason = (timestamp: number) => {
    const latest = latestMotionRef.current;
    if (!latest.continuousAssistScroll) return 'assist cruise disabled';
    if (reduceMotionRef.current) return 'assist cruise reduced motion';
    if (latest.followState !== 'following') {
      return `assist cruise stopped: ${latest.followState}`;
    }
    if (latest.confidence < HIGH_CONFIDENCE) {
      return 'assist cruise stopped: low confidence';
    }
    if (
      assistAnchorRef.current.lastConfirmedAt <= 0 ||
      timestamp - assistAnchorRef.current.lastConfirmedAt >= DEFAULT_ASSIST_STALE_STOP_MS
    ) {
      return 'assist cruise stopped: stale confidence';
    }
    return null;
  };

  const traceableCruiseStopReason = (reason: string | null) => {
    if (!reason) return undefined;
    if (reason === 'assist cruise disabled' || reason === 'assist cruise reduced motion') return undefined;
    return reason;
  };

  const recordAssistAnchor = (
    anchorIndex: number,
    targetScrollTop: number,
    geometry: ReadingZoneGeometry
  ) => {
    const latest = latestMotionRef.current;
    if (
      !latest.continuousAssistScroll ||
      latest.followState !== 'following' ||
      latest.confidence < HIGH_CONFIDENCE
    ) {
      return;
    }

    const now = window.performance?.now?.() ?? Date.now();
    const anchor = assistAnchorRef.current;
    const fallbackVelocityPxPerMs = assistSpeedToVelocityPxPerMs(
      geometry.lineHeightPx,
      latest.assistScrollSpeed
    );

    // Use precise anchorIndex (token preferred over sentence) for intra-sentence deltas and forward detection.
    // This allows pace estimation and cruise from movement *within* a long sentence.
    if (
      anchor.lastConfirmedAt > 0 &&
      anchorIndex >= anchor.lastSentenceIndex &&
      targetScrollTop >= anchor.lastTargetScrollTop - DEFAULT_SCROLL_DEADBAND_PX
    ) {
      anchor.estimatedVelocityPxPerMs = estimateAssistVelocityFromAnchors({
        previousTargetScrollTop: anchor.lastTargetScrollTop,
        nextTargetScrollTop: targetScrollTop,
        elapsedMs: now - anchor.lastConfirmedAt,
        currentEstimatePxPerMs: anchor.estimatedVelocityPxPerMs,
        fallbackVelocityPxPerMs
      });
    } else if (anchor.lastConfirmedAt <= 0 || anchorIndex < anchor.lastSentenceIndex) {
      anchor.estimatedVelocityPxPerMs = 0;
    }

    anchor.lastConfirmedAt = now;
    anchor.lastTargetScrollTop = targetScrollTop;
    anchor.lastSentenceIndex = anchorIndex;
  };

  const runCruise = () => {
    const cruise = cruiseRef.current;
    const container = scrollRef.current;
    const geometry = geometryRef.current;
    if (!container || !geometry || cruise.frameId === null) return;

    cruise.frameId = window.requestAnimationFrame((timestamp) => {
      const activeCruise = cruiseRef.current;
      const activeContainer = scrollRef.current;
      const activeGeometry = geometryRef.current;
      if (!activeContainer || !activeGeometry || activeCruise.frameId === null) return;
      const stopReason = cruiseStopReason(timestamp);
      if (stopReason || animationRef.current.active) {
        cancelCruise(stopReason ? traceableCruiseStopReason(stopReason) : 'assist cruise paused for correction animation');
        return;
      }

      const latest = latestMotionRef.current;
      const staleAgeMs = timestamp - assistAnchorRef.current.lastConfirmedAt;
      const targetVelocityPxPerMs = computeAssistTargetVelocity({
        lineHeightPx: activeGeometry.lineHeightPx,
        speedPercent: latest.assistScrollSpeed,
        estimatedVelocityPxPerMs: assistAnchorRef.current.estimatedVelocityPxPerMs,
        staleAgeMs,
        lagging: latest.assistScrollLagging
      });
      const shouldTraceSlowed = staleAgeMs > DEFAULT_ASSIST_STALE_SLOW_MS || latest.assistScrollLagging;
      if (shouldTraceSlowed && !activeCruise.slowed) {
        activeCruise.slowed = true;
        const age = Math.round(staleAgeMs);
        emitTrace(activeCruise.sentenceIndex, true, `assist cruise slowed (speed=${latest.assistScrollSpeed} feel=${latest.assistCorrectionFeel} age=${age}ms lag=${latest.assistScrollLagging ? 1 : 0})`);
        const pace = assistSpeedToLinesPerMinute(latest.assistScrollSpeed);
        const v = (activeCruise.velocityPxPerMs * 1000);
        reportAssistStatus('slowed: Local Whisper lag', { velocityPxPerSec: v, pace, reason: 'Local Whisper lag' });
      }
      if (!shouldTraceSlowed) {
        activeCruise.slowed = false;
      }

      if (targetVelocityPxPerMs <= 0.0001) {
        cancelCruise('assist cruise stopped: stale confidence');
        return;
      }

      const lastTimestamp = activeCruise.lastTimestamp ?? timestamp;
      activeCruise.lastTimestamp = timestamp;
      const step = computeAssistCruiseStep({
        currentScrollTop: activeContainer.scrollTop,
        scrollHeight: activeContainer.scrollHeight,
        viewportHeight: activeContainer.clientHeight,
        lineHeightPx: activeGeometry.lineHeightPx,
        deltaMs: timestamp - lastTimestamp,
        currentVelocityPxPerMs: activeCruise.velocityPxPerMs,
        targetVelocityPxPerMs
      });
      writeProgrammaticScrollTop(activeContainer, step.nextScrollTop);
      activeCruise.velocityPxPerMs = step.velocityPxPerMs;

      if (step.done) {
        cancelCruise();
        return;
      }

      // Throttled cruise tick summary (~1s) for observability without per-frame spam.
      const nowForTrace = timestamp;
      if (nowForTrace - lastCruiseTraceMsRef.current > 950) {
        lastCruiseTraceMsRef.current = nowForTrace;
        const age = Math.round(timestamp - assistAnchorRef.current.lastConfirmedAt);
        const v = activeCruise.velocityPxPerMs.toFixed(4);
        emitTrace(activeCruise.sentenceIndex, true, `assist cruise tick (age=${age}ms vel=${v} speed=${latest.assistScrollSpeed})`);
        const pace = assistSpeedToLinesPerMinute(latest.assistScrollSpeed);
        reportAssistStatus('cruising', { velocityPxPerSec: activeCruise.velocityPxPerMs * 1000, pace });
      }

      runCruise();
    });
  };

  const startCruise = (sentenceIndex: number) => {
    const now = window.performance?.now?.() ?? Date.now();
    const stopReason = cruiseStopReason(now);
    if (stopReason) {
      cancelCruise(cruiseRef.current.frameId !== null ? traceableCruiseStopReason(stopReason) : undefined);
      return;
    }

    const cruise = cruiseRef.current;
    cruise.sentenceIndex = sentenceIndex;
    if (cruise.frameId !== null) return;

    cruise.frameId = 0;
    cruise.lastTimestamp = null;
    cruise.slowed = false;
    const latest = latestMotionRef.current;
    emitTrace(sentenceIndex, true, `assist cruise started (enabled=${latest.continuousAssistScroll ? 1 : 0} speed=${latest.assistScrollSpeed} feel=${latest.assistCorrectionFeel})`);
    const pace = assistSpeedToLinesPerMinute(latest.assistScrollSpeed);
    reportAssistStatus('cruising', { velocityPxPerSec: 0, pace });
    runCruise();
  };

  const startCorrectionAnimation = ({
    targetScrollTop,
    sentenceIndex,
    source,
    reason,
    resumeCruiseOnComplete
  }: {
    targetScrollTop: number;
    sentenceIndex: number;
    source: 'live' | 'test';
    reason: string;
    resumeCruiseOnComplete: boolean;
  }) => {
    const container = scrollRef.current;
    if (!container) {
      emitTrace(sentenceIndex, false, `animation skipped no container source=${source} reason=${reason}`);
      return false;
    }

    const fromScrollTop = container.scrollTop;
    const plan = computeCorrectionAnimationPlan({
      fromScrollTop,
      targetScrollTop,
      correctionFeelPercent: latestMotionRef.current.assistCorrectionFeel
    });
    const diagnostics = formatAnimationPlan(plan);

    if (plan.distancePx <= 1) {
      cancelAnimation('already close');
      emitTrace(
        sentenceIndex,
        false,
        `animation skipped already close source=${source} reason=${reason} ${diagnostics}`,
        targetScrollTop
      );
      if (resumeCruiseOnComplete) {
        startCruise(sentenceIndex);
      }
      return false;
    }

    if (reduceMotionRef.current) {
      cancelAnimation('reduced motion skip');
      cancelCruise();
      writeScrollTopDirect(container, targetScrollTop, sentenceIndex, source, `reduced motion skip: ${reason}`);
      emitTrace(
        sentenceIndex,
        true,
        `animation skipped reduced motion active source=${source} reason=${reason} ${diagnostics}`,
        targetScrollTop
      );
      reportAnimationStatus('skipped reduced motion', {
        source,
        reason,
        ...planStatusDetails(plan)
      });
      if (resumeCruiseOnComplete) {
        startCruise(sentenceIndex);
      }
      return true;
    }

    if (cruiseRef.current.frameId !== null) {
      emitTrace(sentenceIndex, false, `assist cruise overwritten by correction source=${source} reason=${reason}`);
    }
    cancelCruise();
    const animation = animationRef.current;
    const wasAnimating = animation.active;
    const previousSource = animation.source;
    const previousPlan = animation.plan;
    const previousFrameCount = animation.frameCount;
    animation.plan = plan;
    animation.startTimestamp = null;
    animation.sentenceIndex = sentenceIndex;
    animation.source = source;
    animation.resumeCruiseOnComplete = resumeCruiseOnComplete;
    animation.active = true;
    animation.frameCount = 0;

    if (wasAnimating) {
      const overwrite =
        previousSource === 'test' && source === 'live'
          ? 'overwritten by live follow'
          : previousSource === 'live' && source === 'test'
            ? 'overwritten by scroll test'
            : 'retargeted';
      emitTrace(
        sentenceIndex,
        true,
        `animation retargeted source=${source} previousSource=${previousSource} overwrite=${overwrite} previousFrames=${previousFrameCount} previousTarget=${previousPlan?.targetScrollTop.toFixed(1) ?? 'none'} reason=${reason} ${diagnostics}`,
        targetScrollTop
      );
      reportAnimationStatus(overwrite, {
        source,
        reason,
        frameCount: previousFrameCount,
        ...planStatusDetails(plan)
      });
      return true;
    }

    animation.id += 1;
    const animationId = animation.id;
    emitTrace(
      sentenceIndex,
      true,
      `animation started source=${source} reason=${reason} ${diagnostics}`,
      targetScrollTop
    );
    reportAnimationStatus('animating', {
      source,
      reason,
      frameCount: 0,
      ...planStatusDetails(plan)
    });
    runScrollAnimation(animationId);
    return true;
  };

  const runScrollAnimation = (animationId: number) => {
    const animation = animationRef.current;
    const container = scrollRef.current;
    if (!container || !animation.active || animation.id !== animationId || !animation.plan) return;

    animation.frameId = window.requestAnimationFrame((timestamp) => {
      const activeAnimation = animationRef.current;
      const activeContainer = scrollRef.current;
      const plan = activeAnimation.plan;
      if (!activeContainer || !activeAnimation.active || activeAnimation.id !== animationId || !plan) return;

      if (activeAnimation.startTimestamp === null) {
        activeAnimation.startTimestamp = timestamp;
      }

      const step = interpolateCorrectionScroll(plan, timestamp - activeAnimation.startTimestamp);
      writeProgrammaticScrollTop(activeContainer, step.nextScrollTop);
      activeAnimation.frameCount += 1;

      if (step.done) {
        const completedSentence = activeAnimation.sentenceIndex;
        const completedPlan = plan;
        const completedSource = activeAnimation.source;
        const shouldResumeCruise = activeAnimation.resumeCruiseOnComplete;
        const completedFrameCount = activeAnimation.frameCount;
        activeAnimation.active = false;
        activeAnimation.frameId = null;
        activeAnimation.startTimestamp = null;
        activeAnimation.plan = null;
        activeAnimation.frameCount = 0;
        writeProgrammaticScrollTop(activeContainer, completedPlan.targetScrollTop);
        emitTrace(
          completedSentence,
          true,
          `correction completed; animation completed source=${completedSource} frames=${completedFrameCount} ${formatAnimationPlan(completedPlan)}`,
          completedPlan.targetScrollTop
        );
        reportAnimationStatus('completed', {
          source: completedSource,
          frameCount: completedFrameCount,
          ...planStatusDetails(completedPlan)
        });
        if (shouldResumeCruise) {
          startCruise(completedSentence);
        }
        return;
      }

      runScrollAnimation(animationId);
    });
  };

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;

    const updatePreference = () => {
      reduceMotionRef.current = media.matches;
      if (lastReducedMotionStatusRef.current !== media.matches) {
        lastReducedMotionStatusRef.current = media.matches;
        emitTrace(
          currentSentenceIndexRef.current,
          false,
          `prefers-reduced-motion ${media.matches ? 'active' : 'inactive'}`
        );
        reportAnimationStatus(media.matches ? 'reduced motion active' : 'ready', {
          reason: 'prefers-reduced-motion'
        });
      }
    };

    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    assistAnchorRef.current = {
      lastConfirmedAt: 0,
      lastTargetScrollTop: 0,
      lastSentenceIndex: -1,
      estimatedVelocityPxPerMs: 0
    };
    cancelCruise();
  }, [model.rawText]);

  useEffect(() => {
    const pane = paneRef.current;
    const container = scrollRef.current;
    if (!pane || !container) return;

    const applyGeometry = () => {
      const geometry = computeReadingZoneGeometry({
        viewportHeight: container.clientHeight,
        fontSizePx: settings.fontSizePx,
        lineHeight: settings.lineHeight,
        readingZonePercent: settings.readingZonePercent,
        readingZoneHeightLines: settings.readingZoneHeightLines
      });
      geometryRef.current = geometry;
      pane.style.setProperty('--reading-zone-top', `${geometry.bandTop}px`);
      pane.style.setProperty('--reading-zone-height', `${geometry.bandHeight}px`);
      pane.style.setProperty('--reading-zone-target-y', `${geometry.targetY}px`);
      pane.style.setProperty('--prompter-spacer-top', `${geometry.topSpacerPx}px`);
      pane.style.setProperty('--prompter-spacer-bottom', `${geometry.bottomSpacerPx}px`);
    };

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;

    applyGeometry();
    firstFrame = window.requestAnimationFrame(() => {
      applyGeometry();
      secondFrame = window.requestAnimationFrame(applyGeometry);
    });

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyGeometry) : null;
    observer?.observe(container);
    window.addEventListener('resize', applyGeometry);

    return () => {
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      observer?.disconnect();
      window.removeEventListener('resize', applyGeometry);
    };
  }, [
    layoutMode,
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZoneHeightLines,
    settings.readingZonePercent
  ]);

  useEffect(() => {
    if (
      startupVisibleAnchorRequestId <= 0 ||
      startupVisibleAnchorRequestId === lastStartupVisibleAnchorRequestRef.current
    ) {
      return;
    }
    const container = scrollRef.current;
    if (!container) return;
    const geometry =
      geometryRef.current ??
      computeReadingZoneGeometry({
        viewportHeight: container.clientHeight,
        fontSizePx: settings.fontSizePx,
        lineHeight: settings.lineHeight,
        readingZonePercent: settings.readingZonePercent,
        readingZoneHeightLines: settings.readingZoneHeightLines
      });
    geometryRef.current = geometry;
    const visibleTokenIndex = visibleTokenAtReadingBand(container, geometry);
    lastStartupVisibleAnchorRequestRef.current = startupVisibleAnchorRequestId;
    if (visibleTokenIndex === null) {
      emitTrace(
        currentSentenceIndexRef.current,
        false,
        `startup visible anchor unavailable request=${startupVisibleAnchorRequestId}`
      );
      return;
    }
    emitTrace(
      currentSentenceIndexRef.current,
      false,
      `startup visible anchor set token=${visibleTokenIndex} request=${startupVisibleAnchorRequestId}`
    );
    onStartupVisibleAnchorRef.current?.({
      requestId: startupVisibleAnchorRequestId,
      visibleTokenIndex,
      scrollTop: container.scrollTop
    });
  }, [
    layoutMode,
    model.rawText,
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZoneHeightLines,
    settings.readingZonePercent,
    startupVisibleAnchorRequestId
  ]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    lastObservedScrollTopRef.current = container.scrollTop;

    const now = () => window.performance?.now?.() ?? Date.now();
    const markManualIntent = () => {
      manualScrollIntentUntilRef.current = now() + 1200;
    };
    const stopAutomaticMotionForManualScroll = () => {
      manualScrollHoldRef.current = true;
      cancelAnimation('manual scroll detected');
      cancelCruise('assist cruise stopped: manual scroll');
      assistAnchorRef.current = {
        lastConfirmedAt: 0,
        lastTargetScrollTop: container.scrollTop,
        lastSentenceIndex: -1,
        estimatedVelocityPxPerMs: 0
      };
    };
    const reportSettledManualScroll = () => {
      manualScrollDebounceRef.current = null;
      const geometry =
        geometryRef.current ??
        computeReadingZoneGeometry({
          viewportHeight: container.clientHeight,
          fontSizePx: settings.fontSizePx,
          lineHeight: settings.lineHeight,
          readingZonePercent: settings.readingZonePercent,
          readingZoneHeightLines: settings.readingZoneHeightLines
        });
      geometryRef.current = geometry;
      const visibleTokenIndex = visibleTokenAtReadingBand(container, geometry);
      if (visibleTokenIndex === null) return;
      const direction = pendingManualDirectionRef.current;
      emitTrace(
        currentSentenceIndexRef.current,
        false,
        `manual scroll detected direction=${direction} visible anchor token=${visibleTokenIndex}`
      );
      onManualScrollRef.current?.({
        visibleTokenIndex,
        scrollTop: container.scrollTop,
        direction
      });
    };
    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const previousScrollTop = lastObservedScrollTopRef.current;
      lastObservedScrollTopRef.current = currentScrollTop;
      const direction =
        currentScrollTop < previousScrollTop - 0.5
          ? 'backward'
          : currentScrollTop > previousScrollTop + 0.5
            ? 'forward'
            : 'stationary';
      if (direction === 'stationary') return;

      const latest = latestMotionRef.current;
      if (!latest.manualScrollTrackingEnabled) return;
      const timestamp = now();
      const manualIntentActive = timestamp <= manualScrollIntentUntilRef.current;
      const lastWrite = lastProgrammaticScrollRef.current;
      const matchesRecentProgrammaticWrite = Boolean(
        lastWrite &&
        timestamp - lastWrite.timestampMs <= 300 &&
        Math.abs(currentScrollTop - lastWrite.scrollTop) <= 2
      );
      const automaticMotionActive =
        animationRef.current.active || cruiseRef.current.frameId !== null;
      if (!manualIntentActive && (matchesRecentProgrammaticWrite || automaticMotionActive)) {
        return;
      }

      pendingManualDirectionRef.current = direction;
      stopAutomaticMotionForManualScroll();
      manualScrollIntentUntilRef.current = 0;
      if (manualScrollDebounceRef.current !== null) {
        window.clearTimeout(manualScrollDebounceRef.current);
      }
      manualScrollDebounceRef.current = window.setTimeout(reportSettledManualScroll, 120);
    };
    const handleWheel = () => {
      if (!latestMotionRef.current.manualScrollTrackingEnabled) return;
      markManualIntent();
      stopAutomaticMotionForManualScroll();
    };
    const handlePotentialManualIntent = () => {
      if (latestMotionRef.current.manualScrollTrackingEnabled) markManualIntent();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target === container) handlePotentialManualIntent();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        handlePotentialManualIntent();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handlePotentialManualIntent, { passive: true });
    container.addEventListener('pointerdown', handlePointerDown, { passive: true });
    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handlePotentialManualIntent);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('keydown', handleKeyDown);
      if (manualScrollDebounceRef.current !== null) {
        window.clearTimeout(manualScrollDebounceRef.current);
        manualScrollDebounceRef.current = null;
      }
    };
  }, [
    layoutMode,
    model.rawText,
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZoneHeightLines,
    settings.readingZonePercent
  ]);

  useEffect(() => {
    if (!visibleReacquireActive) {
      manualScrollHoldRef.current = false;
    }
  }, [visibleReacquireActive]);

  useEffect(() => () => {
    cancelAnimation('PrompterView unmounted');
    cancelCruise();
  }, []);

  useEffect(() => {
    if (visibleReacquireActive || manualScrollHoldRef.current) {
      const reacquireLabel =
        visibleReacquireSource === 'startup' ? 'startup visible anchor' : 'manual scroll';
      cancelAnimation(`${reacquireLabel} reacquire pending`);
      cancelCruise(`assist cruise stopped: ${reacquireLabel} reacquire pending`);
      if (settings.continuousAssistScroll) {
        reportAssistStatus(`stopped: ${reacquireLabel}`, {
          velocityPxPerSec: 0,
          reason: `${reacquireLabel} reacquire pending`
        });
      }
      return;
    }

    if (!settings.continuousAssistScroll) {
      if (cruiseRef.current.frameId !== null) {
        cancelCruise('assist cruise disabled');
      }
      reportAssistStatus('OFF');
    }

    if (followState !== 'following' && cruiseRef.current.frameId !== null) {
      cancelCruise(`assist cruise stopped: ${followState}`);
    } else if (
      followState === 'following' &&
      confidence < HIGH_CONFIDENCE &&
      cruiseRef.current.frameId !== null
    ) {
      cancelCruise('assist cruise stopped: low confidence');
    }

    if (!shouldScrollForState(followState, confidence)) {
      cancelAnimation(`scroll state blocked followState=${followState} confidence=${confidence.toFixed(2)}`);
      if (settings.continuousAssistScroll) {
        const st = (followState !== 'following') ? `stopped: ${followState}` : (confidence < HIGH_CONFIDENCE ? 'stopped: low confidence' : 'ON, waiting for confident match');
        reportAssistStatus(st);
      }
      return;
    }

    const container = scrollRef.current;

    // Conservative token lookahead target (confirmed + N). 0 reproduces exact confirmed-token behavior.
    // Global clamp to manuscript; lookahead is allowed to pull the target into the next sentence(s) to reduce lag
    // (the alignment will naturally update confirmed as chunks arrive). The visible band + small tolerance will decide the actual scroll.
    const confirmedToken = currentTokenIndex ?? 0;
    const la = Math.max(0, Math.min(20, settings.readingLookaheadTokens ?? 6));
    let targetTokenIndex = Math.min(confirmedToken + la, (model.tokens?.length || 1) - 1);

    // Use the lookahead target token for the active anchor (for scroll target, band, record for Assist pace).
    // Fallback to confirmed token, then sentence.
    let active = targetTokenIndex != null
      ? container?.querySelector<HTMLElement>(`[data-token-index="${targetTokenIndex}"]`)
      : null;
    let anchorSource: 'token' | 'sentence' = 'token';
    if (!active && currentTokenIndex != null) {
      active = container?.querySelector<HTMLElement>(`[data-token-index="${currentTokenIndex}"]`);
      anchorSource = 'token';
    }
    if (!active) {
      active = container?.querySelector<HTMLElement>(`[data-sentence-index="${currentSentenceIndex}"]`);
      anchorSource = 'sentence';
    }

    if (!container || !active) {
      emitTrace(currentSentenceIndex, false, `no container or active element (source=${anchorSource})`);
      if (settings.continuousAssistScroll) {
        reportAssistStatus('ON, waiting for confident match');
      }
      return;
    }

    const geometry =
      geometryRef.current ??
      computeReadingZoneGeometry({
        viewportHeight: container.clientHeight,
        fontSizePx: settings.fontSizePx,
        lineHeight: settings.lineHeight,
        readingZonePercent: settings.readingZonePercent,
        readingZoneHeightLines: settings.readingZoneHeightLines
      });
    geometryRef.current = geometry;

    const activeRect = active.getClientRects()[0] ?? active.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const activeTopInViewport = activeRect.top - containerRect.top;
    const activeCenterInViewport = computeRenderedLineCenterY(
      activeTopInViewport,
      activeRect.height
    );
    const desiredTop = computePrompterScrollTarget({
      currentScrollTop: container.scrollTop,
      anchorY: activeCenterInViewport,
      scrollHeight: container.scrollHeight,
      viewportHeight: container.clientHeight,
      targetY: geometry.targetY
    });
    const currentScrollTop = container.scrollTop;
    const distance = Math.abs(desiredTop - currentScrollTop);

    // Line-height-based deadband (0.22 lh clamped). Prevents full-line drift while allowing micro jitter.
    const linePx = geometry.lineHeightPx;
    const deadbandPx = Math.max(6, Math.min(28, linePx * 0.22));
    const alreadyInBand = isAnchorNearReadingTarget(
      activeCenterInViewport,
      geometry,
      deadbandPx
    );

    // Record using the lookahead target token (confirmed + N). This makes Assist Scroll use the lookahead as its anchor basis
    // (pace estimation and cruise advance target the "now/next" position rather than the last confirmed ASR token).
    const anchorForRecord = targetTokenIndex;
    recordAssistAnchor(anchorForRecord, desiredTop, geometry);

    const targetTok = model.tokens?.[targetTokenIndex];
    const confirmedTok = model.tokens?.[confirmedToken];
    const anchorText = (active.textContent || '').trim().slice(0, 40);
    const traceReasonBase = `${anchorSource} confirmedT=${confirmedToken} targetT=${targetTokenIndex} s${currentSentenceIndex} "${anchorText}"`;

    const bandH = geometry.bandHeight;
    const bandHLines = bandH / linePx;
    const deadLines = deadbandPx / linePx;
    const distToTarget = activeCenterInViewport - geometry.targetY;
    const distLines = distToTarget / linePx;
    const insideBand =
      activeCenterInViewport >= geometry.bandTop &&
      activeCenterInViewport <= geometry.bandBottom;
    const decisionReason = alreadyInBand
      ? 'centered on target'
      : insideBand
        ? 'inside band, off-center'
        : 'needs correction';

    // Rich diagnostics include the rendered line center, band height, target offset, deadband,
    // anchor distance in line heights, and the resulting correction decision.
    // These appear in the Alignment Trace (Debug panel).
    emitTrace(currentSentenceIndex, false, `anchor-detail confirmedT=${confirmedToken} targetT=${targetTokenIndex} src=${anchorSource} topInView=${activeTopInViewport.toFixed(1)} centerInView=${activeCenterInViewport.toFixed(1)} targetY=${geometry.targetY.toFixed(1)} targetOffset=${geometry.targetOffsetPx.toFixed(1)}px/${(geometry.targetOffsetPx / linePx).toFixed(2)}lh distToTarget=${distToTarget.toFixed(1)}px/${distLines.toFixed(2)}lh bandH=${bandH.toFixed(1)}px/${bandHLines.toFixed(2)}lh deadband=${deadbandPx.toFixed(1)}px/${deadLines.toFixed(2)}lh decision=${decisionReason} already=${alreadyInBand} d=${distance.toFixed(1)}`);

    // Visible diagnostics (for ControlPanel live display)
    const debugKey = `${confirmedToken}|${targetTokenIndex}|${la}|${distLines.toFixed(2)}|${bandHLines.toFixed(2)}|${decisionReason}`;
    if (debugKey !== lastAnchorDebugKeyRef.current) {
      lastAnchorDebugKeyRef.current = debugKey;
      onAnchorDebugRef.current?.({
        confirmedToken,
        targetToken: targetTokenIndex,
        lookahead: la,
        distLines,
        decision: decisionReason,
        bandH,
        bandHeightLines: geometry.readingZoneHeightLines,
        lineH: linePx,
        targetY: geometry.targetY,
        targetOffsetPx: geometry.targetOffsetPx,
        targetOffsetLines: geometry.targetOffsetPx / linePx,
        toleranceZoneH: deadbandPx * 2
      });
    }

    if (alreadyInBand || distance <= deadbandPx) {
      cancelAnimation(`live follow already in reading band decision=${decisionReason}`);
      emitTrace(currentSentenceIndex, false, `already in reading band (${traceReasonBase} decision=${decisionReason})`, desiredTop);
      startCruise(currentSentenceIndex);
      return;
    }

    startCorrectionAnimation({
      targetScrollTop: desiredTop,
      sentenceIndex: currentSentenceIndex,
      source: 'live',
      reason: `animated to reading band (${traceReasonBase})`,
      resumeCruiseOnComplete: true
    });
  }, [
    assistScrollLagging,
    confidence,
    currentSentenceIndex,
    currentTokenIndex,
    followState,
    layoutMode,
    model.rawText,
    visibleReacquireActive,
    visibleReacquireSource,
    settings.assistCorrectionFeel,
    settings.assistScrollSpeed,
    settings.continuousAssistScroll,
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZoneHeightLines,
    settings.readingZonePercent,
    settings.readingLookaheadTokens
  ]);

  useEffect(() => {
    if (!scrollTestRequest) return;
    const container = scrollRef.current;
    if (!container) {
      emitTrace(currentSentenceIndex, false, `animation test skipped no container id=${scrollTestRequest.id}`);
      return;
    }

    const geometry =
      geometryRef.current ??
      computeReadingZoneGeometry({
        viewportHeight: container.clientHeight,
        fontSizePx: settings.fontSizePx,
        lineHeight: settings.lineHeight,
        readingZonePercent: settings.readingZonePercent,
        readingZoneHeightLines: settings.readingZoneHeightLines
      });
    geometryRef.current = geometry;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const fromScrollTop = container.scrollTop;
    if (scrollTestRequest.type === 'reset') {
      cancelAnimation('scroll test reset');
      cancelCruise();
      writeScrollTopDirect(container, 0, currentSentenceIndex, 'test', 'reset test scroll position');
      return;
    }

    const targetScrollTop = Math.max(
      0,
      Math.min(
        maxScrollTop,
        fromScrollTop + geometry.lineHeightPx * Math.max(1, scrollTestRequest.lineCount ?? 1)
      )
    );
    const testReason = `${Math.max(1, scrollTestRequest.lineCount ?? 1)} lines`;

    emitTrace(
      currentSentenceIndex,
      true,
      `animation test started ${testReason} from=${fromScrollTop.toFixed(1)} target=${targetScrollTop.toFixed(1)} distance=${Math.abs(targetScrollTop - fromScrollTop).toFixed(1)} feel=${latestMotionRef.current.assistCorrectionFeel}`,
      targetScrollTop
    );
    startCorrectionAnimation({
      targetScrollTop,
      sentenceIndex: currentSentenceIndex,
      source: 'test',
      reason: `animation test ${testReason}`,
      resumeCruiseOnComplete: false
    });
  }, [scrollTestRequest?.id]);

  return (
    <main className={`prompter-pane theme-${settings.theme}`} ref={paneRef}>
      <div className="reading-zone-band" aria-hidden="true" />
      <div className="prompter-scroll" ref={scrollRef}>
        <article
          className="manuscript-display"
          style={{
            fontFamily: settings.fontFamily,
            fontSize: `${settings.fontSizePx}px`,
            lineHeight: settings.lineHeight,
            maxWidth: `${settings.textWidthCh}ch`
          }}
        >
          {model.paragraphs.length === 0 ? (
            <p className="empty-manuscript">Paste or import a manuscript to begin.</p>
          ) : (
            model.paragraphs.map((paragraph) => (
              <p
                key={paragraph.paragraphIndex}
                style={{ marginBottom: `${settings.paragraphSpacingEm}em` }}
              >
                {/* Render from original *paragraph* text (per req). Insert sentence spans by char offsets into paragraph.text.
                    Emit inter-sentence whitespace (e.g. space after ".") as plain text nodes between sentence spans.
                    Inside each sentence span, insert token spans by offsets into the sentence slice; non-token parts (punct) as plain text.
                    This guarantees exact original visible text including all spaces after sentence-ending punctuation, while keeping data-* anchors for token-level scroll/Assist. */}
                {(() => {
                  const pText = paragraph.text;
                  const pStart = paragraph.charStart;
                  const sents = model.sentences.slice(paragraph.sentenceStart, paragraph.sentenceEnd);
                  const nodes: any[] = [];
                  let pos = 0;
                  for (const sent of sents) {
                    const relS = sent.charStart - pStart;
                    const relE = sent.charEnd - pStart;
                    if (relS > pos) {
                      // inter-sentence gap (the space(s) after previous sentence's terminal punct)
                      nodes.push(pText.slice(pos, relS));
                    }
                    // sentence span with original slice content + nested token anchors
                    const sentSlice = pText.slice(relS, relE);
                    const sentStartAbs = sent.charStart; // for token rel calc (tokens use sentence's char context)
                    const toks = model.tokens.slice(sent.tokenStart, sent.tokenEnd);
                    const sentInner: any[] = [];
                    let tpos = 0;
                    for (const tok of toks) {
                      const tRelS = tok.charStart - sentStartAbs;
                      const tRelE = tok.charEnd - sentStartAbs;
                      if (tRelS > tpos) {
                        sentInner.push(sentSlice.slice(tpos, tRelS));
                      }
                      if (tRelE > tRelS) {
                        sentInner.push(
                          <span
                            key={tok.tokenIndex}
                            data-token-index={tok.tokenIndex}
                            data-sentence-index={sent.sentenceIndex}
                          >
                            {sentSlice.slice(tRelS, tRelE)}
                          </span>
                        );
                      }
                      tpos = tRelE;
                    }
                    if (tpos < sentSlice.length) {
                      sentInner.push(sentSlice.slice(tpos));
                    }
                    nodes.push(
                      <span
                        key={sent.sentenceIndex}
                        data-sentence-index={sent.sentenceIndex}
                        className={
                          settings.showActiveHighlight && sent.sentenceIndex === currentSentenceIndex
                            ? 'sentence active'
                            : 'sentence'
                        }
                      >
                        {sentInner}
                      </span>
                    );
                    pos = relE;
                  }
                  if (pos < pText.length) {
                    nodes.push(pText.slice(pos));
                  }
                  return nodes;
                })()}
              </p>
            ))
          )}
        </article>
      </div>
    </main>
  );
}
