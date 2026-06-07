import { useEffect, useRef } from 'react';
import {
  DEFAULT_ASSIST_STALE_SLOW_MS,
  DEFAULT_ASSIST_STALE_STOP_MS,
  DEFAULT_SCROLL_DEADBAND_PX,
  assistSpeedToVelocityPxPerMs,
  computeAssistCruiseStep,
  computeAssistTargetVelocity,
  computePrompterScrollTarget,
  computeReadingZoneGeometry,
  correctionFeelToMotion,
  estimateAssistVelocityFromAnchors,
  isAnchorInReadingBand,
  stepPrompterScroll,
  type ReadingZoneGeometry
} from '../domain/prompterScroll';
import { HIGH_CONFIDENCE, shouldScrollForState } from '../domain/scrollModel';
import type { DisplaySettings, FollowState, ManuscriptModel } from '../domain/types';

type Props = {
  model: ManuscriptModel;
  currentSentenceIndex: number;
  followState: FollowState;
  confidence: number;
  settings: DisplaySettings;
  layoutMode?: 'with-controls' | 'prompter-only';
  assistScrollLagging?: boolean;
  onTraceScroll?: (info: { sentenceIndex: number; didScroll: boolean; reason: string }) => void;
};

export function PrompterView({
  model,
  currentSentenceIndex,
  followState,
  confidence,
  settings,
  layoutMode = 'with-controls',
  assistScrollLagging = false,
  onTraceScroll
}: Props) {
  const paneRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const geometryRef = useRef<ReadingZoneGeometry | null>(null);
  const reduceMotionRef = useRef(false);
  const animationRef = useRef<{
    frameId: number | null;
    lastTimestamp: number | null;
    targetScrollTop: number;
    velocityPxPerMs: number;
    sentenceIndex: number;
  }>({
    frameId: null,
    lastTimestamp: null,
    targetScrollTop: 0,
    velocityPxPerMs: 0,
    sentenceIndex: -1
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
  const latestMotionRef = useRef({
    followState,
    confidence,
    continuousAssistScroll: settings.continuousAssistScroll,
    assistScrollSpeed: settings.assistScrollSpeed,
    assistCorrectionFeel: settings.assistCorrectionFeel,
    assistScrollLagging
  });

  // Store latest callback in ref so we can call it without including the (possibly unstable) callback
  // in the main scroll effect's dependency array. This prevents parent state updates from retriggering
  // the effect via prop identity.
  const onTraceScrollRef = useRef(onTraceScroll);
  useEffect(() => {
    onTraceScrollRef.current = onTraceScroll;
  }, [onTraceScroll]);

  useEffect(() => {
    latestMotionRef.current = {
      followState,
      confidence,
      continuousAssistScroll: settings.continuousAssistScroll,
      assistScrollSpeed: settings.assistScrollSpeed,
      assistCorrectionFeel: settings.assistCorrectionFeel,
      assistScrollLagging
    };
  }, [
    assistScrollLagging,
    confidence,
    followState,
    settings.assistCorrectionFeel,
    settings.assistScrollSpeed,
    settings.continuousAssistScroll
  ]);

  // Remember last emitted scroll trace key so we only emit when the scroll *decision* actually changes
  // (sentence + followState + confidence bucket + didScroll), not on every effect run or re-render.
  const lastScrollTraceKeyRef = useRef<string | null>(null);

  const emitTrace = (sentenceIndex: number, didScroll: boolean, reason: string, targetScrollTop?: number) => {
    const confBucket = Math.floor(confidence * 100);
    const targetBucket = targetScrollTop === undefined ? 'none' : Math.round(targetScrollTop / 4);
    const key = `${reason}|${sentenceIndex}|${followState}|${confBucket}|${didScroll ? 1 : 0}|${targetBucket}`;
    if (key !== lastScrollTraceKeyRef.current) {
      lastScrollTraceKeyRef.current = key;
      onTraceScrollRef.current?.({ sentenceIndex, didScroll, reason });
    }
  };

  const cancelAnimation = () => {
    const animation = animationRef.current;
    if (animation.frameId !== null) {
      window.cancelAnimationFrame(animation.frameId);
      animation.frameId = null;
    }
    animation.lastTimestamp = null;
    animation.velocityPxPerMs = 0;
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
    sentenceIndex: number,
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

    if (
      anchor.lastConfirmedAt > 0 &&
      sentenceIndex >= anchor.lastSentenceIndex &&
      targetScrollTop >= anchor.lastTargetScrollTop - DEFAULT_SCROLL_DEADBAND_PX
    ) {
      anchor.estimatedVelocityPxPerMs = estimateAssistVelocityFromAnchors({
        previousTargetScrollTop: anchor.lastTargetScrollTop,
        nextTargetScrollTop: targetScrollTop,
        elapsedMs: now - anchor.lastConfirmedAt,
        currentEstimatePxPerMs: anchor.estimatedVelocityPxPerMs,
        fallbackVelocityPxPerMs
      });
    } else if (anchor.lastConfirmedAt <= 0 || sentenceIndex < anchor.lastSentenceIndex) {
      anchor.estimatedVelocityPxPerMs = 0;
    }

    anchor.lastConfirmedAt = now;
    anchor.lastTargetScrollTop = targetScrollTop;
    anchor.lastSentenceIndex = sentenceIndex;
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
      if (stopReason || animationRef.current.frameId !== null) {
        cancelCruise(traceableCruiseStopReason(stopReason));
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
        emitTrace(activeCruise.sentenceIndex, true, 'assist cruise slowed');
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
      activeContainer.scrollTop = step.nextScrollTop;
      activeCruise.velocityPxPerMs = step.velocityPxPerMs;

      if (step.done) {
        cancelCruise();
        return;
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
    emitTrace(sentenceIndex, true, 'assist cruise started');
    runCruise();
  };

  const runScrollAnimation = () => {
    const animation = animationRef.current;
    const container = scrollRef.current;
    if (!container || animation.frameId === null) return;

    animation.frameId = window.requestAnimationFrame((timestamp) => {
      const activeAnimation = animationRef.current;
      const activeContainer = scrollRef.current;
      if (!activeContainer || activeAnimation.frameId === null) return;

      const lastTimestamp = activeAnimation.lastTimestamp ?? timestamp;
      activeAnimation.lastTimestamp = timestamp;
      const correctionMotion = correctionFeelToMotion(
        latestMotionRef.current.assistCorrectionFeel
      );
      const step = stepPrompterScroll({
        currentScrollTop: activeContainer.scrollTop,
        targetScrollTop: activeAnimation.targetScrollTop,
        velocityPxPerMs: activeAnimation.velocityPxPerMs,
        deltaMs: timestamp - lastTimestamp,
        maxVelocityPxPerMs: correctionMotion.maxVelocityPxPerMs,
        accelerationPxPerMs2: correctionMotion.accelerationPxPerMs2
      });

      activeContainer.scrollTop = step.nextScrollTop;
      activeAnimation.velocityPxPerMs = step.velocityPxPerMs;

      if (step.done) {
        const completedSentence = activeAnimation.sentenceIndex;
        const completedTarget = activeAnimation.targetScrollTop;
        activeAnimation.frameId = null;
        activeAnimation.lastTimestamp = null;
        activeAnimation.velocityPxPerMs = 0;
        activeContainer.scrollTop = completedTarget;
        emitTrace(completedSentence, true, 'correction completed', completedTarget);
        startCruise(completedSentence);
        return;
      }

      runScrollAnimation();
    });
  };

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;

    const updatePreference = () => {
      reduceMotionRef.current = media.matches;
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
        readingZonePercent: settings.readingZonePercent
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
    settings.readingZonePercent
  ]);

  useEffect(() => () => {
    cancelAnimation();
    cancelCruise();
  }, []);

  useEffect(() => {
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
      cancelAnimation();
      return;
    }

    const container = scrollRef.current;
    const active = container?.querySelector<HTMLElement>(`[data-sentence-index="${currentSentenceIndex}"]`);

    if (!container || !active) {
      emitTrace(currentSentenceIndex, false, 'no container or active element');
      return;
    }

    const geometry =
      geometryRef.current ??
      computeReadingZoneGeometry({
        viewportHeight: container.clientHeight,
        fontSizePx: settings.fontSizePx,
        lineHeight: settings.lineHeight,
        readingZonePercent: settings.readingZonePercent
      });
    geometryRef.current = geometry;

    const activeRect = active.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const activeTopInViewport = activeRect.top - containerRect.top;
    const desiredTop = computePrompterScrollTarget({
      currentScrollTop: container.scrollTop,
      anchorY: activeTopInViewport,
      scrollHeight: container.scrollHeight,
      viewportHeight: container.clientHeight,
      targetY: geometry.targetY
    });
    const currentScrollTop = container.scrollTop;
    const distance = Math.abs(desiredTop - currentScrollTop);
    const alreadyInBand = isAnchorInReadingBand(
      activeTopInViewport,
      geometry,
      DEFAULT_SCROLL_DEADBAND_PX
    );

    recordAssistAnchor(currentSentenceIndex, desiredTop, geometry);

    if (alreadyInBand || distance <= DEFAULT_SCROLL_DEADBAND_PX) {
      cancelAnimation();
      emitTrace(currentSentenceIndex, false, 'already in reading band', desiredTop);
      startCruise(currentSentenceIndex);
      return;
    }

    if (reduceMotionRef.current) {
      cancelAnimation();
      cancelCruise();
      container.scrollTop = desiredTop;
      emitTrace(currentSentenceIndex, true, 'reduced motion', desiredTop);
      return;
    }

    const inheritedCruiseVelocityPxPerMs = cruiseRef.current.velocityPxPerMs;
    cancelCruise();
    const animation = animationRef.current;
    const wasAnimating = animation.frameId !== null;
    animation.targetScrollTop = desiredTop;
    animation.sentenceIndex = currentSentenceIndex;

    if (wasAnimating) {
      emitTrace(currentSentenceIndex, true, 'correction retargeted', desiredTop);
      return;
    }

    animation.frameId = 0;
    animation.lastTimestamp = null;
    animation.velocityPxPerMs = desiredTop >= currentScrollTop ? Math.max(0, inheritedCruiseVelocityPxPerMs) : 0;
    emitTrace(currentSentenceIndex, true, 'correction scroll started', desiredTop);
    runScrollAnimation();
  }, [
    assistScrollLagging,
    confidence,
    currentSentenceIndex,
    followState,
    layoutMode,
    model.rawText,
    settings.assistCorrectionFeel,
    settings.assistScrollSpeed,
    settings.continuousAssistScroll,
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZonePercent
  ]);

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
                {model.sentences
                  .slice(paragraph.sentenceStart, paragraph.sentenceEnd)
                  .map((sentence) => (
                    <span
                      key={sentence.sentenceIndex}
                      data-sentence-index={sentence.sentenceIndex}
                      className={
                        settings.showActiveHighlight && sentence.sentenceIndex === currentSentenceIndex
                          ? 'sentence active'
                          : 'sentence'
                      }
                    >
                      {sentence.text}
                      {' '}
                    </span>
                  ))}
              </p>
            ))
          )}
        </article>
      </div>
    </main>
  );
}
