import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';
import { ServerSessionBridge } from '../../electron/server/ServerSessionBridge';
import { SessionCoordinator as RendererCoordinator } from '../session/SessionCoordinator';
import { SessionCoordinator as SharedCoordinator } from '../../shared/session/SessionCoordinator';

function sync(rendererRevision: number, overrides: Partial<Parameters<ServerSessionBridge['applyRendererSync']>[0]> = {}) {
  return {
    rendererRevision,
    manuscriptText: 'One two three. Four five six.',
    manuscriptId: 'test-manuscript',
    currentTokenIndex: 0,
    followState: 'following' as const,
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
    selectedProviderId: 'manual' as const,
    transcriptSourceActive: false,
    sessionResetId: 0,
    ...overrides
  };
}

describe('ServerSessionBridge', () => {
  it('uses the exact same coordinator implementation in renderer and Electron imports', () => {
    expect(RendererCoordinator).toBe(SharedCoordinator);
    expect(new ServerSessionBridge()).toBeInstanceOf(ServerSessionBridge);
  });
  it('accepts initial state, suppresses duplicates, and rejects stale revisions', () => {
    const bridge = new ServerSessionBridge();
    expect(bridge.applyRendererSync(sync(1)).accepted).toBe(true);
    expect(bridge.applyRendererSync(sync(2)).duplicate).toBe(true);
    expect(bridge.applyRendererSync(sync(1, { currentTokenIndex: 2 })).stale).toBe(true);
  });

  it('replaces manuscripts and applies reset and position updates', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    bridge.applyRendererSync(sync(2, { manuscriptText: 'Alpha beta. Gamma delta.', currentTokenIndex: 2, sessionResetId: 1 }));
    expect(bridge.getSnapshot()?.manuscript.manuscriptId).toBe('test-manuscript');
    expect(bridge.getState()?.currentTokenIndex).toBe(2);
    expect(bridge.getState()?.manuscriptRevision).toBeGreaterThan(0);
  });

  it('enforces one source and protects tablet position from renderer projection', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    expect(bridge.acquireController('tablet-1')).toBe(true);
    expect(bridge.acquireController('tablet-2')).toBe(false);
    bridge.applyRendererSync(sync(2, { currentTokenIndex: 0 }));
    expect(bridge.getControllerDeviceId()).toBe('tablet-1');
    bridge.releaseController('tablet-1');
    bridge.applyRendererSync(sync(3, { transcriptSourceActive: true }));
    expect(bridge.acquireController('tablet-1')).toBe(false);
  });
});
