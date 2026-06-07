import { describe, expect, it } from 'vitest';
import {
  computeAssistCruiseStep,
  computePrompterScrollTarget,
  computeReadingZoneGeometry,
  isAnchorInReadingBand,
  stepPrompterScroll
} from '../domain/prompterScroll';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';

describe('prompter reading-zone geometry', () => {
  it('places the default reading band around the vertical center', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50
    });

    expect(geometry.bandTop).toBeGreaterThan(390);
    expect(geometry.bandBottom).toBeLessThan(510);
    expect(geometry.targetY).toBeGreaterThanOrEqual(geometry.bandTop);
    expect(geometry.targetY).toBeLessThanOrEqual(geometry.bandBottom);
  });

  it('places the narration default band higher for real reading', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: DEFAULT_DISPLAY_SETTINGS.readingZonePercent
    });

    expect(DEFAULT_DISPLAY_SETTINGS.readingZonePercent).toBe(38);
    expect(DEFAULT_DISPLAY_SETTINGS.showActiveHighlight).toBe(false);
    expect(geometry.bandTop).toBeGreaterThan(285);
    expect(geometry.bandBottom).toBeLessThan(400);
  });

  it('moves the band higher when the reading-zone percent is lower', () => {
    const higher = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 35
    });
    const lower = computeReadingZoneGeometry({
      viewportHeight: 900,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 45
    });

    expect(higher.bandTop).toBeLessThan(lower.bandTop);
    expect(higher.targetY).toBeLessThan(lower.targetY);
  });

  it('adds enough spacer for first and last lines to reach the band', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 720,
      fontSizePx: 32,
      lineHeight: 1.5,
      readingZonePercent: 50
    });

    expect(geometry.topSpacerPx).toBeCloseTo(geometry.targetY, 5);
    expect(geometry.bottomSpacerPx).toBeGreaterThan(720 - geometry.targetY);
  });

  it('treats near-target anchors as already inside the band', () => {
    const geometry = computeReadingZoneGeometry({
      viewportHeight: 800,
      fontSizePx: 34,
      lineHeight: 1.55,
      readingZonePercent: 50
    });

    expect(isAnchorInReadingBand(geometry.targetY + 8, geometry, 18)).toBe(true);
    expect(isAnchorInReadingBand(geometry.bandBottom + 42, geometry, 18)).toBe(false);
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
});
