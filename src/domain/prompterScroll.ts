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

export type AssistVelocityEstimateInput = {
  previousTargetScrollTop: number;
  nextTargetScrollTop: number;
  elapsedMs: number;
  currentEstimatePxPerMs?: number;
  fallbackVelocityPxPerMs: number;
};

export type AssistTargetVelocityInput = {
  lineHeightPx: number;
  speedPercent: number;
  estimatedVelocityPxPerMs?: number;
  staleAgeMs: number;
  staleSlowMs?: number;
  staleStopMs?: number;
  lagging?: boolean;
};

export type AssistCruiseStepInput = {
  currentScrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  lineHeightPx: number;
  deltaMs: number;
  linesPerMinute?: number;
  currentVelocityPxPerMs?: number;
  targetVelocityPxPerMs?: number;
  accelerationPxPerMs2?: number;
  maxFrameDeltaPx?: number;
};

export type AssistCruiseStep = {
  nextScrollTop: number;
  velocityPxPerMs: number;
  done: boolean;
};

export const DEFAULT_SCROLL_DEADBAND_PX = 18;
export const DEFAULT_ASSIST_CRUISE_MS = 6000;
export const DEFAULT_ASSIST_STALE_SLOW_MS = 3600;
export const DEFAULT_ASSIST_STALE_STOP_MS = 9000;

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

export function assistSpeedToLinesPerMinute(speedPercent: number) {
  const safePercent = clamp(Number.isFinite(speedPercent) ? speedPercent : 50, 1, 100);
  return 6 + safePercent * 0.34;
}

export function assistSpeedToVelocityPxPerMs(lineHeightPx: number, speedPercent: number) {
  return (Math.max(1, lineHeightPx) * assistSpeedToLinesPerMinute(speedPercent)) / 60000;
}

export function estimateAssistVelocityFromAnchors({
  previousTargetScrollTop,
  nextTargetScrollTop,
  elapsedMs,
  currentEstimatePxPerMs = 0,
  fallbackVelocityPxPerMs
}: AssistVelocityEstimateInput) {
  const fallback = Math.max(0, fallbackVelocityPxPerMs);
  const currentEstimate = Math.max(0, currentEstimatePxPerMs);
  const deltaPx = nextTargetScrollTop - previousTargetScrollTop;

  if (elapsedMs < 700 || elapsedMs > 15000 || deltaPx <= 3) {
    return currentEstimate || fallback;
  }

  const measuredVelocity = deltaPx / elapsedMs;
  const minVelocity = fallback > 0 ? fallback * 0.35 : 0.002;
  const maxVelocity = fallback > 0 ? fallback * 3.2 : 0.08;
  const clampedVelocity = clamp(measuredVelocity, minVelocity, maxVelocity);

  return currentEstimate > 0
    ? currentEstimate * 0.65 + clampedVelocity * 0.35
    : clampedVelocity;
}

export function computeAssistTargetVelocity({
  lineHeightPx,
  speedPercent,
  estimatedVelocityPxPerMs = 0,
  staleAgeMs,
  staleSlowMs = DEFAULT_ASSIST_STALE_SLOW_MS,
  staleStopMs = DEFAULT_ASSIST_STALE_STOP_MS,
  lagging = false
}: AssistTargetVelocityInput) {
  if (staleAgeMs >= staleStopMs) return 0;

  const baseVelocity = assistSpeedToVelocityPxPerMs(lineHeightPx, speedPercent);
  const measuredVelocity =
    estimatedVelocityPxPerMs > 0
      ? clamp(estimatedVelocityPxPerMs, baseVelocity * 0.35, baseVelocity * 2.8)
      : baseVelocity;
  const staleRatio =
    staleAgeMs <= staleSlowMs
      ? 1
      : 1 - clamp((staleAgeMs - staleSlowMs) / Math.max(1, staleStopMs - staleSlowMs), 0, 1);
  const lagRatio = lagging ? 0.45 : 1;

  return (baseVelocity * 0.35 + measuredVelocity * 0.65) * staleRatio * lagRatio;
}

export function correctionFeelToMotion(feelPercent: number) {
  const safePercent = clamp(Number.isFinite(feelPercent) ? feelPercent : 45, 1, 100);
  const t = (safePercent - 1) / 99;
  return {
    maxVelocityPxPerMs: 0.55 + t * 0.95,
    accelerationPxPerMs2: 0.0018 + t * 0.0036
  };
}

export function computeAssistCruiseStep({
  currentScrollTop,
  scrollHeight,
  viewportHeight,
  lineHeightPx,
  deltaMs,
  linesPerMinute = 7,
  currentVelocityPxPerMs,
  targetVelocityPxPerMs,
  accelerationPxPerMs2 = 0.00018,
  maxFrameDeltaPx = 7
}: AssistCruiseStepInput): AssistCruiseStep {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  const frameMs = clamp(deltaMs, 1, 50);
  const desiredVelocity =
    targetVelocityPxPerMs ??
    (Math.max(1, lineHeightPx) * Math.max(0, linesPerMinute)) / 60000;
  const nextVelocity =
    currentVelocityPxPerMs === undefined
      ? desiredVelocity
      : currentVelocityPxPerMs +
        clamp(
          desiredVelocity - currentVelocityPxPerMs,
          -accelerationPxPerMs2 * frameMs,
          accelerationPxPerMs2 * frameMs
        );
  const frameDelta = clamp(nextVelocity * frameMs, 0, maxFrameDeltaPx);
  const nextScrollTop = clamp(currentScrollTop + frameDelta, 0, maxScrollTop);
  return {
    nextScrollTop,
    velocityPxPerMs: nextVelocity,
    done: nextScrollTop >= maxScrollTop
  };
}
