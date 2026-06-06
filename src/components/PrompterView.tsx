import { useEffect, useRef } from 'react';
import { shouldScrollForState } from '../domain/scrollModel';
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!shouldScrollForState(followState, confidence)) return;
    const container = scrollRef.current;
    const active = container?.querySelector<HTMLElement>(`[data-sentence-index="${currentSentenceIndex}"]`);

    let didScrollLocal = false;
    let reasonLocal = '';

    if (!container || !active) {
      didScrollLocal = false;
      reasonLocal = 'no container or active element';
      const confBucket = Math.floor(confidence * 10);
      const key = `err:${currentSentenceIndex}|${followState}|${confBucket}|0`;
      if (key !== lastScrollTraceKeyRef.current) {
        lastScrollTraceKeyRef.current = key;
        onTraceScrollRef.current?.({ sentenceIndex: currentSentenceIndex, didScroll: didScrollLocal, reason: reasonLocal });
      }
      return;
    }

    const readingZone = container.clientHeight * (settings.readingZonePercent / 100);
    const desiredTop = Math.max(0, active.offsetTop - readingZone + active.offsetHeight / 2);
    const currentScrollTop = container.scrollTop;
    const delta = Math.abs(desiredTop - currentScrollTop);
    const TOLERANCE = 24;
    didScrollLocal = delta > TOLERANCE;
    reasonLocal = didScrollLocal
      ? 'high-conf advance to reading zone'
      : 'matched but target already visible (within tolerance of reading zone)';

    const confBucket = Math.floor(confidence * 10);
    const key = `${currentSentenceIndex}|${followState}|${confBucket}|${didScrollLocal ? 1 : 0}`;
    if (key !== lastScrollTraceKeyRef.current) {
      lastScrollTraceKeyRef.current = key;
      onTraceScrollRef.current?.({ sentenceIndex: currentSentenceIndex, didScroll: didScrollLocal, reason: reasonLocal });
    }

    if (didScrollLocal) {
      container.scrollTo({ top: desiredTop, behavior: 'smooth' });
    }
  }, [confidence, currentSentenceIndex, followState, settings.readingZonePercent]);

  return (
    <main className={`prompter-pane theme-${settings.theme}`}>
      <div className="reading-zone-line" style={{ top: `${settings.readingZonePercent}%` }} />
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
                      className={sentence.sentenceIndex === currentSentenceIndex ? 'sentence active' : 'sentence'}
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
