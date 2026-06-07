export type ReadingZoneGeometryInput = {
  viewportHeight: number;
  fontSizePx: number;
  lineHeight: number;
  readingZonePercent: number;
};

export type ReadingZoneGeometry = {
  viewportHeight: number;
  lineHeightPx: number;
  readingZonePercent: number;
  bandTop: number;
  bandHeight: number;
  bandBottom: number;
  targetY: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
};

export type ScrollTargetInput = {
  currentScrollTop: number;
  anchorY: number;
  scrollHeight: number;
  viewportHeight: number;
  targetY: number;
};

export type ScrollAnimationStepInput = {
  currentScrollTop: number;
  targetScrollTop: number;
  velocityPxPerMs: number;
  deltaMs: number;
  maxVelocityPxPerMs?: number;
  accelerationPxPerMs2?: number;
  stopDistancePx?: number;
  stopVelocityPxPerMs?: number;
};

export type ScrollAnimationStep = {
  nextScrollTop: number;
  velocityPxPerMs: number;
  done: boolean;
};

export const DEFAULT_SCROLL_DEADBAND_PX = 18;
export const DEFAULT_ASSIST_CRUISE_MS = 6000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function computeReadingZoneGeometry({
  viewportHeight,
  fontSizePx,
  lineHeight,
  readingZonePercent
}: ReadingZoneGeometryInput): ReadingZoneGeometry {
  const safeViewportHeight = Math.max(1, viewportHeight);
  const safeLineHeightPx = Math.max(1, fontSizePx * lineHeight);
  const safePercent = clamp(readingZonePercent, 5, 95);
  const bandHeight = safeLineHeightPx * 1.45;
  const bandTop = clamp(
    (safeViewportHeight * safePercent) / 100 - bandHeight / 2,
    0,
    Math.max(0, safeViewportHeight - bandHeight)
  );
  const bandBottom = bandTop + bandHeight;
  const targetY = clamp(
    bandTop + Math.min(bandHeight * 0.32, Math.max(6, safeLineHeightPx * 0.25)),
    bandTop,
    bandBottom
  );

  return {
    viewportHeight: safeViewportHeight,
    lineHeightPx: safeLineHeightPx,
    readingZonePercent: safePercent,
    bandTop,
    bandHeight,
    bandBottom,
    targetY,
    topSpacerPx: targetY,
    bottomSpacerPx: Math.max(safeLineHeightPx * 2, safeViewportHeight - targetY + safeLineHeightPx)
  };
}

export function computePrompterScrollTarget({
  currentScrollTop,
  anchorY,
  scrollHeight,
  viewportHeight,
  targetY
}: ScrollTargetInput) {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  return clamp(currentScrollTop + anchorY - targetY, 0, maxScrollTop);
}

export function isAnchorInReadingBand(
  anchorY: number,
  geometry: ReadingZoneGeometry,
  tolerancePx = DEFAULT_SCROLL_DEADBAND_PX
) {
  return anchorY >= geometry.bandTop - tolerancePx && anchorY <= geometry.bandBottom + tolerancePx;
}

export function stepPrompterScroll({
  currentScrollTop,
  targetScrollTop,
  velocityPxPerMs,
  deltaMs,
  maxVelocityPxPerMs = 1.25,
  accelerationPxPerMs2 = 0.0042,
  stopDistancePx = 0.75,
  stopVelocityPxPerMs = 0.025
}: ScrollAnimationStepInput): ScrollAnimationStep {
  const frameMs = clamp(deltaMs, 1, 50);
  const distance = targetScrollTop - currentScrollTop;

  if (Math.abs(distance) <= stopDistancePx && Math.abs(velocityPxPerMs) <= stopVelocityPxPerMs) {
    return {
      nextScrollTop: targetScrollTop,
      velocityPxPerMs: 0,
      done: true
    };
  }

  const direction = Math.sign(distance) || 1;
  const brakingVelocity = Math.sqrt(Math.max(0, 2 * accelerationPxPerMs2 * Math.abs(distance)));
  const desiredVelocity = direction * Math.min(maxVelocityPxPerMs, brakingVelocity);
  const velocityChangeLimit =
    accelerationPxPerMs2 * frameMs * (Math.sign(velocityPxPerMs) === -direction ? 1.8 : 1);
  const nextVelocity =
    velocityPxPerMs + clamp(desiredVelocity - velocityPxPerMs, -velocityChangeLimit, velocityChangeLimit);
  const nextScrollTop = currentScrollTop + nextVelocity * frameMs;
  const remainingAfterStep = targetScrollTop - nextScrollTop;

  if (Math.sign(distance) !== Math.sign(remainingAfterStep) || Math.abs(remainingAfterStep) <= stopDistancePx) {
    return {
      nextScrollTop: targetScrollTop,
      velocityPxPerMs: 0,
      done: true
    };
  }

  return {
    nextScrollTop,
    velocityPxPerMs: nextVelocity,
    done: false
  };
}

export function computeAssistCruiseStep({
  currentScrollTop,
  scrollHeight,
  viewportHeight,
  lineHeightPx,
  deltaMs,
  linesPerMinute = 7
}: {
  currentScrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  lineHeightPx: number;
  deltaMs: number;
  linesPerMinute?: number;
}) {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  const pixelsPerMs = (Math.max(1, lineHeightPx) * Math.max(0, linesPerMinute)) / 60000;
  const nextScrollTop = clamp(currentScrollTop + pixelsPerMs * clamp(deltaMs, 1, 50), 0, maxScrollTop);
  return {
    nextScrollTop,
    done: nextScrollTop >= maxScrollTop
  };
}
