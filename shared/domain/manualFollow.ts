// Shared by the desktop renderer and the Electron-hosted server coordinator.
export const MANUAL_REACQUIRE_BACKWARD_WINDOW = 120;
export const MANUAL_REACQUIRE_FORWARD_WINDOW = 220;

export type VisibleReacquireSource = 'manual-scroll' | 'startup';

export type VisibleTokenPosition = {
  tokenIndex: number;
  topInViewport: number;
};

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
  return source === 'manual-scroll' || !hadFreshConfirmedAnchor;
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
