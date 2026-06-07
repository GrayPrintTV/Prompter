import { useEffect, useRef } from 'react';
import {
  DEFAULT_ASSIST_CRUISE_MS,
  DEFAULT_SCROLL_DEADBAND_PX,
  computeAssistCruiseStep,
  computePrompterScrollTarget,
  computeReadingZoneGeometry,
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
  onTraceScroll?: (info: { sentenceIndex: number; didScroll: boolean; reason: string }) => void;
};

export function PrompterView({
  model,
  currentSentenceIndex,
  followState,
  confidence,
  settings,
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
    expiresAt: number;
    sentenceIndex: number;
  }>({
    frameId: null,
    lastTimestamp: null,
    expiresAt: 0,
    sentenceIndex: -1
  });

  // Store latest callback in ref so we can call it without including the (possibly unstable) callback
  // in the main scroll effect's dependency array. This prevents parent state updates from retriggering
  // the effect via prop identity.
  const onTraceScrollRef = useRef(onTraceScroll);
  useEffect(() => {
    onTraceScrollRef.current = onTraceScroll;
  }, [onTraceScroll]);

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

  const cancelCruise = () => {
    const cruise = cruiseRef.current;
    if (cruise.frameId !== null) {
      window.cancelAnimationFrame(cruise.frameId);
      cruise.frameId = null;
    }
    cruise.lastTimestamp = null;
  };

  const cruiseAllowed = () => (
    settings.continuousAssistScroll &&
    !reduceMotionRef.current &&
    confidence >= HIGH_CONFIDENCE &&
    shouldScrollForState(followState, confidence)
  );

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
      if (!cruiseAllowed() || animationRef.current.frameId !== null || timestamp > activeCruise.expiresAt) {
        cancelCruise();
        return;
      }

      const lastTimestamp = activeCruise.lastTimestamp ?? timestamp;
      activeCruise.lastTimestamp = timestamp;
      const step = computeAssistCruiseStep({
        currentScrollTop: activeContainer.scrollTop,
        scrollHeight: activeContainer.scrollHeight,
        viewportHeight: activeContainer.clientHeight,
        lineHeightPx: activeGeometry.lineHeightPx,
        deltaMs: timestamp - lastTimestamp
      });
      activeContainer.scrollTop = step.nextScrollTop;

      if (step.done) {
        cancelCruise();
        return;
      }

      runCruise();
    });
  };

  const startCruise = (sentenceIndex: number) => {
    if (!cruiseAllowed()) {
      cancelCruise();
      return;
    }

    const cruise = cruiseRef.current;
    const now = window.performance?.now?.() ?? Date.now();
    cruise.expiresAt = now + DEFAULT_ASSIST_CRUISE_MS;
    cruise.sentenceIndex = sentenceIndex;
    if (cruise.frameId !== null) return;

    cruise.frameId = 0;
    cruise.lastTimestamp = null;
    emitTrace(sentenceIndex, true, 'continuous assist scroll');
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
      const step = stepPrompterScroll({
        currentScrollTop: activeContainer.scrollTop,
        targetScrollTop: activeAnimation.targetScrollTop,
        velocityPxPerMs: activeAnimation.velocityPxPerMs,
        deltaMs: timestamp - lastTimestamp
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
        emitTrace(completedSentence, true, 'completed scroll', completedTarget);
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

    applyGeometry();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyGeometry) : null;
    observer?.observe(container);
    window.addEventListener('resize', applyGeometry);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', applyGeometry);
    };
  }, [
    settings.fontSizePx,
    settings.lineHeight,
    settings.readingZonePercent
  ]);

  useEffect(() => () => {
    cancelAnimation();
    cancelCruise();
  }, []);

  useEffect(() => {
    if (!shouldScrollForState(followState, confidence)) {
      cancelAnimation();
      cancelCruise();
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

    cancelCruise();
    const animation = animationRef.current;
    const wasAnimating = animation.frameId !== null;
    animation.targetScrollTop = desiredTop;
    animation.sentenceIndex = currentSentenceIndex;

    if (wasAnimating) {
      emitTrace(currentSentenceIndex, true, 'retargeted existing scroll', desiredTop);
      return;
    }

    animation.frameId = 0;
    animation.lastTimestamp = null;
    emitTrace(currentSentenceIndex, true, 'animated to reading band', desiredTop);
    runScrollAnimation();
  }, [
    confidence,
    currentSentenceIndex,
    followState,
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
