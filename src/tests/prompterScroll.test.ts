import { describe, expect, it } from 'vitest';
import {
  assistSpeedToLinesPerMinute,
  computeAssistTargetVelocity,
  computeCorrectionAnimationPlan,
  computeAssistCruiseStep,
  DEFAULT_CORRECTION_MAX_DURATION_MS,
  DEFAULT_CORRECTION_MIN_DURATION_MS,
  computePrompterScrollTarget,
  computeRenderedLineCenterY,
  computeReadingZoneGeometry,
  correctionFeelToMotion,
  easeInOutCubic,
  estimateAssistVelocityFromAnchors,
  interpolateCorrectionScroll,
  isAnchorInReadingBand,
  isAnchorNearReadingTarget,
  stepPrompterScroll
} from '../domain/prompterScroll';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';

describe('prompter reading-zone geometry', () => {
  it('places a one-line reading band around the vertical center', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50,
      readingZoneHeightLines: 1
    });

    expect(geometry.bandHeight).toBeCloseTo(geometry.lineHeightPx, 5);
    expect(geometry.bandTop).toBeCloseTo(450 - geometry.lineHeightPx / 2, 5);
    expect(geometry.targetY).toBe(450);
    expect(geometry.targetOffsetPx).toBeCloseTo(geometry.bandHeight / 2, 5);
  });

  it('places the narration default band higher for real reading', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: DEFAULT_DISPLAY_SETTINGS.readingZonePercent,
      readingZoneHeightLines: DEFAULT_DISPLAY_SETTINGS.readingZoneHeightLines
    });

    expect(DEFAULT_DISPLAY_SETTINGS.readingZonePercent).toBe(38);
    expect(DEFAULT_DISPLAY_SETTINGS.showActiveHighlight).toBe(false);
    expect(geometry.targetY).toBeCloseTo(342, 5);
    expect(geometry.bandHeight).toBeCloseTo(geometry.lineHeightPx, 5);
  });

  it('scales and clamps Focus Bar height in line heights', () => {
    const taller = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50,
      readingZoneHeightLines: 2.2
    });
    const clamped = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50,
      readingZoneHeightLines: 8
    });

    expect(taller.bandHeight).toBeCloseTo(taller.lineHeightPx * 2.2, 5);
    expect(taller.targetY).toBe(450);
    expect(clamped.readingZoneHeightLines).toBe(2.5);
  });

  it('moves the band higher when the reading-zone percent is lower', () => {
    const higher = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 35,
      readingZoneHeightLines: 1
    });
    const lower = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 45,
      readingZoneHeightLines: 1
    });

    expect(higher.bandTop).toBeLessThan(lower.bandTop);
    expect(higher.targetY).toBeLessThan(lower.targetY);
  });

  it('adds enough spacer for first and last lines to reach the band', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 720,
      fontSizePx: 32,
      lineHeight: 1.5,
      readingZonePercent: 50,
      readingZoneHeightLines: 1
    });

    expect(geometry.topSpacerPx + geometry.lineHeightPx / 2).toBeCloseTo(
      geometry.targetY,
      5
    );
    expect(geometry.bottomSpacerPx).toBeGreaterThan(720 - geometry.targetY);
  });

  it('treats near-target anchors as already inside the band (line-based deadband ~0.22 lh)', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 800,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50,
      readingZoneHeightLines: 2.5
    });
    const linePx = geometry.lineHeightPx; // ~52.7
    const dead = Math.max(6, Math.min(28, linePx * 0.22)); // ~11.6 px
    // Near target (within ~0.6 * dead) still inside; far beyond band+dead is out.
    expect(isAnchorInReadingBand(geometry.targetY + dead * 0.6, geometry, dead)).toBe(true);
    expect(isAnchorInReadingBand(geometry.bandBottom + dead * 2.5, geometry, dead)).toBe(false);
    expect(isAnchorNearReadingTarget(geometry.targetY + dead * 0.6, geometry, dead)).toBe(true);
    expect(isAnchorNearReadingTarget(geometry.bandTop + 2, geometry, dead)).toBe(false);
  });

  it('targets the visual center of the rendered token line', () => {
    expect(computeRenderedLineCenterY(312, 36)).toBe(330);
  });
});

describe('prompter scroll controller helpers', () => {
  it('computes the scroll target that puts an anchor in the reading band', () => {
    const target = computePrompterScrollTarget({
      currentScrollTop: 300,
      anchorY: 620,
      scrollHeight: 3000,
      viewportHeight: 900,
      targetY: 450
    });

    expect(target).toBe(470);
  });

  it('accelerates gently and never overshoots the target', () => {
    let currentScrollTop = 0;
    let velocityPxPerMs = 0;

    for (let frame = 0; frame < 180; frame += 1) {
      const step = stepPrompterScroll({
        currentScrollTop,
        targetScrollTop: 600,
        velocityPxPerMs,
        deltaMs: 16
      });
      expect(step.nextScrollTop).toBeLessThanOrEqual(600);
      expect(step.nextScrollTop).toBeGreaterThanOrEqual(currentScrollTop);
      currentScrollTop = step.nextScrollTop;
      velocityPxPerMs = step.velocityPxPerMs;
      if (step.done) break;
    }

    expect(currentScrollTop).toBeCloseTo(600, 1);
    expect(velocityPxPerMs).toBe(0);
  });

  it('retargets without snapping by preserving velocity continuity', () => {
    const first = stepPrompterScroll({
      currentScrollTop: 200,
      targetScrollTop: 900,
      velocityPxPerMs: 0.5,
      deltaMs: 16
    });
    const retargeted = stepPrompterScroll({
      currentScrollTop: first.nextScrollTop,
      targetScrollTop: 420,
      velocityPxPerMs: first.velocityPxPerMs,
      deltaMs: 16
    });

    expect(Math.abs(retargeted.nextScrollTop - first.nextScrollTop)).toBeLessThan(30);
    expect(retargeted.nextScrollTop).toBeLessThan(420);
  });

  it('plans deterministic cubic correction animations from distance and feel', () => {
    const shortGentle = computeCorrectionAnimationPlan({
      fromScrollTop: 100,
      targetScrollTop: 150,
      correctionFeelPercent: 20
    });
    const longGentle = computeCorrectionAnimationPlan({
      fromScrollTop: 100,
      targetScrollTop: 900,
      correctionFeelPercent: 20
    });
    const longFirm = computeCorrectionAnimationPlan({
      fromScrollTop: 100,
      targetScrollTop: 900,
      correctionFeelPercent: 85
    });

    expect(shortGentle.easingCurve).toBe('cubic ease-in-out');
    expect(shortGentle.durationMs).toBeGreaterThanOrEqual(DEFAULT_CORRECTION_MIN_DURATION_MS);
    expect(longGentle.durationMs).toBeGreaterThan(shortGentle.durationMs);
    expect(longGentle.durationMs).toBeLessThanOrEqual(DEFAULT_CORRECTION_MAX_DURATION_MS);
    expect(longFirm.durationMs).toBeLessThan(longGentle.durationMs);
  });

  it('keeps multi-line proof moves long enough to be visibly animated', () => {
    const gentleFifteenLines = computeCorrectionAnimationPlan({
      fromScrollTop: 0,
      targetScrollTop: 780,
      correctionFeelPercent: 10
    });
    const firmFifteenLines = computeCorrectionAnimationPlan({
      fromScrollTop: 0,
      targetScrollTop: 780,
      correctionFeelPercent: 95
    });

    expect(gentleFifteenLines.durationMs).toBeGreaterThan(1700);
    expect(firmFifteenLines.durationMs).toBeGreaterThan(900);
    expect(firmFifteenLines.durationMs).toBeLessThan(gentleFifteenLines.durationMs);
  });

  it('interpolates eased correction scroll without overshoot', () => {
    const plan = computeCorrectionAnimationPlan({
      fromScrollTop: 100,
      targetScrollTop: 500,
      correctionFeelPercent: 45
    });

    const start = interpolateCorrectionScroll(plan, 0);
    const middle = interpolateCorrectionScroll(plan, plan.durationMs / 2);
    const end = interpolateCorrectionScroll(plan, plan.durationMs);

    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutCubic(1)).toBe(1);
    expect(start.nextScrollTop).toBe(100);
    expect(middle.nextScrollTop).toBeGreaterThan(100);
    expect(middle.nextScrollTop).toBeLessThan(500);
    expect(end.nextScrollTop).toBe(500);
    expect(end.done).toBe(true);
  });

  it('moves continuous assist scroll slowly and clamps at the bottom', () => {
    const step = computeAssistCruiseStep({
      currentScrollTop: 100,
      scrollHeight: 2000,
      viewportHeight: 800,
      lineHeightPx: 52,
      deltaMs: 1000
    });

    expect(step.nextScrollTop).toBeGreaterThan(100);
    expect(step.nextScrollTop).toBeLessThan(110);

    const bottom = computeAssistCruiseStep({
      currentScrollTop: 1199.9,
      scrollHeight: 2000,
      viewportHeight: 800,
      lineHeightPx: 52,
      deltaMs: 1000
    });

    expect(bottom.nextScrollTop).toBe(1200);
    expect(bottom.done).toBe(true);
  });

  it('maps assist speed controls to slower and faster cruise rates', () => {
    expect(assistSpeedToLinesPerMinute(20)).toBeLessThan(assistSpeedToLinesPerMinute(80));
    expect(assistSpeedToLinesPerMinute(50)).toBeGreaterThan(20);
  });

  it('estimates assist pace from confirmed target movement over time', () => {
    const fallbackVelocityPxPerMs = 52 * 22 / 60000;
    const estimate = estimateAssistVelocityFromAnchors({
      previousTargetScrollTop: 300,
      nextTargetScrollTop: 456,
      elapsedMs: 4000,
      fallbackVelocityPxPerMs
    });

    expect(estimate).toBeGreaterThan(fallbackVelocityPxPerMs);
    expect(estimate).toBeLessThan(fallbackVelocityPxPerMs * 3.2);
  });

  it('decays assist velocity as confirmed alignment gets stale', () => {
    const fresh = computeAssistTargetVelocity({
      lineHeightPx: 52,
      speedPercent: 50,
      staleAgeMs: 1200
    });
    const stale = computeAssistTargetVelocity({
      lineHeightPx: 52,
      speedPercent: 50,
      staleAgeMs: 6500
    });
    const expired = computeAssistTargetVelocity({
      lineHeightPx: 52,
      speedPercent: 50,
      staleAgeMs: 9500
    });

    expect(stale).toBeLessThan(fresh);
    expect(expired).toBe(0);
  });

  it('slows assist velocity when transcription is lagging', () => {
    const normal = computeAssistTargetVelocity({
      lineHeightPx: 52,
      speedPercent: 50,
      staleAgeMs: 1200
    });
    const lagging = computeAssistTargetVelocity({
      lineHeightPx: 52,
      speedPercent: 50,
      staleAgeMs: 1200,
      lagging: true
    });

    expect(lagging).toBeLessThan(normal);
    expect(lagging).toBeGreaterThan(0);
  });

  it('accelerates assist cruise toward the target velocity without a frame jump', () => {
    const step = computeAssistCruiseStep({
      currentScrollTop: 200,
      scrollHeight: 4000,
      viewportHeight: 900,
      lineHeightPx: 52,
      deltaMs: 50,
      currentVelocityPxPerMs: 0,
      targetVelocityPxPerMs: 0.08,
      maxFrameDeltaPx: 3
    });

    expect(step.nextScrollTop).toBeGreaterThan(200);
    expect(step.nextScrollTop - 200).toBeLessThanOrEqual(3);
    expect(step.velocityPxPerMs).toBeGreaterThan(0);
  });

  it('maps correction feel to gentler or firmer braking settings', () => {
    const gentle = correctionFeelToMotion(20);
    const firm = correctionFeelToMotion(85);

    expect(firm.maxVelocityPxPerMs).toBeGreaterThan(gentle.maxVelocityPxPerMs);
    expect(firm.accelerationPxPerMs2).toBeGreaterThan(gentle.accelerationPxPerMs2);
  });
});
