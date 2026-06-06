import { useEffect, useRef } from 'react';
import { shouldScrollForState } from '../domain/scrollModel';
import type { DisplaySettings, FollowState, ManuscriptModel } from '../domain/types';

type Props = {
  model: ManuscriptModel;
  currentSentenceIndex: number;
  followState: FollowState;
  confidence: number;
  settings: DisplaySettings;
};

export function PrompterView({
  model,
  currentSentenceIndex,
  followState,
  confidence,
  settings
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!shouldScrollForState(followState, confidence)) return;
    const container = scrollRef.current;
    const active = container?.querySelector<HTMLElement>(`[data-sentence-index="${currentSentenceIndex}"]`);
    if (!container || !active) return;

    const readingZone = container.clientHeight * (settings.readingZonePercent / 100);
    const top = active.offsetTop - readingZone + active.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
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
