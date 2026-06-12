import { describe, expect, it } from 'vitest';
import {
  isNearManualVisibleAnchor,
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

  it('allows cold-start rollback only before a fresh confirmed anchor exists', () => {
    expect(visibleReacquireAllowsBackward('startup', false)).toBe(true);
    expect(visibleReacquireAllowsBackward('startup', true)).toBe(false);
    expect(visibleReacquireAllowsBackward('manual-scroll', true)).toBe(true);
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
});
