// Shared by the desktop renderer and the Electron-hosted server coordinator.
export const MANUAL_REACQUIRE_BACKWARD_WINDOW = 120;
export const MANUAL_REACQUIRE_FORWARD_WINDOW = 220;
export const TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_TOKENS = 64;
export const TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_PARAGRAPHS = 1;
export const TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_SENTENCES = 8;
export const TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_CHARACTERS = 1200;
export const MANUAL_SCROLL_INTENT_MS = 1600;
export const MANUAL_SCROLL_SETTLE_MS = 220;

export type VisibleReacquireSource = 'manual-scroll' | 'tablet-manual-scroll' | 'startup';
export type ManualScrollInputSource =
  | 'wheel'
  | 'pointer'
  | 'touch'
  | 'keyboard'
  | 'scrollbar'
  | 'unknown';

export type VisibleTokenPosition = {
  tokenIndex: number;
  topInViewport: number;
};

export type TabletManualAnchorLocation = {
  tokenIndex: number;
  character: number;
  sentenceIndex: number;
  paragraphIndex: number;
};

export function isAuthoritativeTargetNearTabletManualAnchor(
  anchor: TabletManualAnchorLocation,
  target: TabletManualAnchorLocation
) {
  return (
    Math.abs(target.tokenIndex - anchor.tokenIndex) <= TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_TOKENS &&
    Math.abs(target.paragraphIndex - anchor.paragraphIndex) <= TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_PARAGRAPHS &&
    Math.abs(target.sentenceIndex - anchor.sentenceIndex) <= TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_SENTENCES &&
    Math.abs(target.character - anchor.character) <= TABLET_MANUAL_AUTHORITATIVE_REACQUIRE_TOLERANCE_CHARACTERS
  );
}

export function manualScrollInputSourceForPointer({
  pointerType,
  targetIsScrollContainer,
  offsetX,
  clientWidth
}: {
  pointerType: string;
  targetIsScrollContainer: boolean;
  offsetX: number;
  clientWidth: number;
}): ManualScrollInputSource {
  if (pointerType === 'touch') return 'touch';
  if (
    targetIsScrollContainer &&
    Number.isFinite(offsetX) &&
    Number.isFinite(clientWidth) &&
    offsetX >= clientWidth
  ) {
    return 'scrollbar';
  }
  return 'pointer';
}

export function shouldHoldAutomaticBackwardCandidate({
  candidateTokenIndex,
  confirmedAnchorTokenIndex,
  explicitBackwardAllowed = false,
  visibleReacquireAllowsBackward = false
}: {
  candidateTokenIndex: number;
  confirmedAnchorTokenIndex: number;
  explicitBackwardAllowed?: boolean;
  visibleReacquireAllowsBackward?: boolean;
}) {
  return (
    candidateTokenIndex < confirmedAnchorTokenIndex &&
    !explicitBackwardAllowed &&
    !visibleReacquireAllowsBackward
  );
}

export function visibleReacquireAllowsBackward(
  source: VisibleReacquireSource,
  hadFreshConfirmedAnchor: boolean
) {
  return source === 'manual-scroll' || source === 'tablet-manual-scroll' || !hadFreshConfirmedAnchor;
}

export function isNearManualVisibleAnchor(
  candidateTokenIndex: number,
  visibleAnchorTokenIndex: number,
  backwardWindow = MANUAL_REACQUIRE_BACKWARD_WINDOW,
  forwardWindow = MANUAL_REACQUIRE_FORWARD_WINDOW
) {
  return (
    candidateTokenIndex >= visibleAnchorTokenIndex - Math.max(0, backwardWindow) &&
    candidateTokenIndex <= visibleAnchorTokenIndex + Math.max(0, forwardWindow)
  );
}

export function nearestVisibleTokenIndex(
  positions: VisibleTokenPosition[],
  readingBandTargetY: number
) {
  let nearest: VisibleTokenPosition | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const position of positions) {
    if (!Number.isFinite(position.tokenIndex) || !Number.isFinite(position.topInViewport)) continue;
    const distance = Math.abs(position.topInViewport - readingBandTargetY);
    if (distance < nearestDistance) {
      nearest = position;
      nearestDistance = distance;
    }
  }

  return nearest ? Math.max(0, Math.round(nearest.tokenIndex)) : null;
}
