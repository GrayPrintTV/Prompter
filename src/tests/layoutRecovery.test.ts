import { describe, expect, it } from 'vitest';
import { shouldRecoverControlsFromHiddenLayout } from '../domain/layoutRecovery';

describe('hidden-controls layout recovery', () => {
  it('does not recover when controls are already visible', () => {
    expect(
      shouldRecoverControlsFromHiddenLayout({
        controlsVisible: true,
        stageWidth: 0,
        stageHeight: 0
      })
    ).toBe(false);
  });

  it('recovers hidden controls from an invalid zero-width prompter pane', () => {
    expect(
      shouldRecoverControlsFromHiddenLayout({
        controlsVisible: false,
        stageWidth: 0,
        stageHeight: 700
      })
    ).toBe(true);
  });

  it('recovers hidden controls from an invalid zero-height prompter pane', () => {
    expect(
      shouldRecoverControlsFromHiddenLayout({
        controlsVisible: false,
        stageWidth: 900,
        stageHeight: 0
      })
    ).toBe(true);
  });

  it('keeps hidden controls when the prompter pane has a usable size', () => {
    expect(
      shouldRecoverControlsFromHiddenLayout({
        controlsVisible: false,
        stageWidth: 900,
        stageHeight: 700
      })
    ).toBe(false);
  });
});
