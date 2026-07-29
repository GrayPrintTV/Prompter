import { describe, expect, it, vi } from 'vitest';
import { TabletModeController } from '../../electron/server/TabletModeController';

describe('TabletModeController', () => {
  it('enters for a controller, hides the window, and exits without reopening it', () => {
    const hooks = { hideMainWindow: vi.fn(), notifyRenderer: vi.fn(), record: vi.fn() };
    const mode = new TabletModeController(hooks);
    expect(mode.getStatus().mode).toBe('desktop');
    mode.setController('tablet-1', 'Galaxy Tab A8', 'lease granted');
    expect(mode.getStatus()).toEqual(expect.objectContaining({ mode: 'tablet', deviceId: 'tablet-1', deviceName: 'Galaxy Tab A8' }));
    expect(hooks.hideMainWindow).toHaveBeenCalledOnce();
    expect(mode.shouldHideOnWindowClose(false)).toBe(true);
    expect(mode.getStatus().mode).toBe('tablet');
    mode.setController(null, null, 'lease released');
    expect(mode.getStatus().mode).toBe('desktop');
    expect(hooks.hideMainWindow).toHaveBeenCalledOnce();
    expect(mode.shouldHideOnWindowClose(false)).toBe(false);
  });

  it('does not re-enter for duplicate lease notifications and explicit quit may close', () => {
    const hooks = { hideMainWindow: vi.fn(), notifyRenderer: vi.fn(), record: vi.fn() };
    const mode = new TabletModeController(hooks);
    mode.setController('tablet-1', 'Galaxy Tab A8', 'lease granted');
    mode.setController('tablet-1', 'Galaxy Tab A8', 'duplicate');
    expect(hooks.record).toHaveBeenCalledTimes(1);
    expect(mode.shouldHideOnWindowClose(true)).toBe(false);
  });
});
