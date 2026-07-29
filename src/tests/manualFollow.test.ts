import { describe, expect, it } from 'vitest';
import {
  isAuthoritativeTargetNearTabletManualAnchor,
  isNearManualVisibleAnchor,
  manualScrollInputSourceForPointer,
  nearestVisibleTokenIndex,
  shouldHoldAutomaticBackwardCandidate,
  visibleReacquireAllowsBackward
} from '../domain/manualFollow';

describe('manual-backtrack-safe following policy', () => {
  it('holds automatic backward candidates but permits explicit backward paths', () => {
    expect(
      shouldHoldAutomaticBackwardCandidate({
        candidateTokenIndex: 90,
        confirmedAnchorTokenIndex: 100
      })
    ).toBe(true);
    expect(
      shouldHoldAutomaticBackwardCandidate({
        candidateTokenIndex: 90,
        confirmedAnchorTokenIndex: 100,
        explicitBackwardAllowed: true
      })
    ).toBe(false);
    expect(
      shouldHoldAutomaticBackwardCandidate({
        candidateTokenIndex: 90,
        confirmedAnchorTokenIndex: 100,
        visibleReacquireAllowsBackward: true
      })
    ).toBe(false);
    expect(
      shouldHoldAutomaticBackwardCandidate({
        candidateTokenIndex: 101,
        confirmedAnchorTokenIndex: 100
      })
    ).toBe(false);
  });

  it('requires manual reacquisition to stay near the visible anchor', () => {
    expect(isNearManualVisibleAnchor(380, 400)).toBe(true);
    expect(isNearManualVisibleAnchor(610, 400)).toBe(true);
    expect(isNearManualVisibleAnchor(621, 400)).toBe(false);
    expect(isNearManualVisibleAnchor(279, 400)).toBe(false);
  });

  it('requires tablet authoritative fallback targets to remain in the anchor manuscript region', () => {
    const anchor = { tokenIndex: 48, character: 480, sentenceIndex: 20, paragraphIndex: 10 };
    expect(isAuthoritativeTargetNearTabletManualAnchor(anchor, {
      tokenIndex: 16, character: 160, sentenceIndex: 8, paragraphIndex: 4
    })).toBe(false);
    expect(isAuthoritativeTargetNearTabletManualAnchor(anchor, {
      tokenIndex: 52, character: 500, sentenceIndex: 21, paragraphIndex: 10
    })).toBe(true);
    expect(isAuthoritativeTargetNearTabletManualAnchor({
      tokenIndex: 58, character: 580, sentenceIndex: 22, paragraphIndex: 10
    }, {
      tokenIndex: 16, character: 160, sentenceIndex: 8, paragraphIndex: 4
    })).toBe(false);
  });

  it('allows cold-start rollback only before a fresh confirmed anchor exists', () => {
    expect(visibleReacquireAllowsBackward('startup', false)).toBe(true);
    expect(visibleReacquireAllowsBackward('startup', true)).toBe(false);
    expect(visibleReacquireAllowsBackward('manual-scroll', true)).toBe(true);
    expect(visibleReacquireAllowsBackward('tablet-manual-scroll', true)).toBe(true);
  });

  it('selects the manuscript token nearest the reading-band target', () => {
    expect(
      nearestVisibleTokenIndex(
        [
          { tokenIndex: 20, topInViewport: 250 },
          { tokenIndex: 21, topInViewport: 312 },
          { tokenIndex: 22, topInViewport: 380 }
        ],
        320
      )
    ).toBe(21);
    expect(nearestVisibleTokenIndex([], 320)).toBeNull();
  });

  it('classifies touch, scrollbar, and ordinary pointer intent separately', () => {
    expect(manualScrollInputSourceForPointer({
      pointerType: 'touch', targetIsScrollContainer: false, offsetX: 20, clientWidth: 500
    })).toBe('touch');
    expect(manualScrollInputSourceForPointer({
      pointerType: 'mouse', targetIsScrollContainer: true, offsetX: 500, clientWidth: 500
    })).toBe('scrollbar');
    expect(manualScrollInputSourceForPointer({
      pointerType: 'pen', targetIsScrollContainer: false, offsetX: 20, clientWidth: 500
    })).toBe('pointer');
  });
});
