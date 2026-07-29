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

  it('includes Windows runtime follow and palette settings in snapshots without changing manuscript revision', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    const first = bridge.getSnapshot()!;
    const changed = { ...DEFAULT_DISPLAY_SETTINGS, backgroundColor: '#000000', highlightOpacity: .25, assistCorrectionFeel: 80 };
    bridge.applyRendererSync(sync(2, { displaySettings: changed }));
    const second = bridge.getSnapshot()!;
    expect(second.manuscriptRevision).toBe(first.manuscriptRevision);
    expect(second.runtimeSettings).toEqual(expect.objectContaining({ settingsRevision: expect.any(Number), display: expect.objectContaining({ backgroundColor: '#000000', highlightOpacity: .25 }), follow: expect.objectContaining({ smoothness: .8 }) }));
  });

  it('replaces manuscripts and applies reset and position updates', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    bridge.applyRendererSync(sync(2, { manuscriptText: 'Alpha beta. Gamma delta.', currentTokenIndex: 2, sessionResetId: 1 }));
    expect(bridge.getSnapshot()?.manuscript.manuscriptId).toBe('test-manuscript');
    expect(bridge.getState()?.currentTokenIndex).toBe(0);
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

  it('keeps transport session ID stable across movement revisions and changes it only on reset', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    const sessionId = bridge.getSessionId();
    bridge.acquireController('tablet-1');
    bridge.processTabletTranscript('tablet-1', 'One two three');
    expect(bridge.getSessionId()).toBe(sessionId);
    bridge.releaseController('tablet-1');
    bridge.applyRendererSync(sync(2, { sessionResetId: 1 }));
    expect(bridge.getSessionId()).not.toBe(sessionId);
  });

  it('replaces manuscript without transferring tablet control back to the renderer', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    bridge.acquireController('tablet-1');
    const previousRevision = bridge.getState()!.manuscriptRevision;
    bridge.applyRendererSync(sync(2, { manuscriptText: 'Alpha beta gamma. Delta epsilon zeta.', manuscriptId: 'replacement' }));
    expect(bridge.getControllerDeviceId()).toBe('tablet-1');
    expect(bridge.getState()!.manuscriptRevision).toBeGreaterThan(previousRevision);
    const processed = bridge.processTabletTranscript('tablet-1', 'Alpha beta gamma');
    expect(processed.transcript.manuscriptRevision).toBe(bridge.getState()!.manuscriptRevision);
    expect(bridge.getSnapshot()!.manuscript.manuscriptId).toBe('replacement');
  });

  it('announces controller authority before projecting coordinator state', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1));
    const order: string[] = [];
    bridge.onController(() => order.push('mode'));
    bridge.onState(() => order.push('state'));
    bridge.acquireController('tablet-1');
    expect(order.slice(-2)).toEqual(['mode', 'state']);
  });

  it('starts a fresh tablet narration from manuscript beginning instead of inherited renderer position', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1, { currentTokenIndex: 4 }));
    bridge.acquireController('tablet-1');
    const start = bridge.startTabletNarration('tablet-1', 'stream-1');
    expect(start).toEqual(expect.objectContaining({ policy: 'beginning', positionSource: 'reset', acceptedCharacter: 0 }));
    expect(bridge.getState()?.currentTokenIndex).toBe(0);
  });

  it('only resumes an explicitly preserved position for the same manuscript', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1, { currentTokenIndex: 4 }));
    bridge.acquireController('tablet-1');
    bridge.selectTabletPositionFromWindowsView();
    const first = bridge.startTabletNarration('tablet-1', 'stream-1');
    expect(first.positionSource).toBe('windows-view');
    expect(first.acceptedCharacter).toBeGreaterThan(0);
    bridge.endTabletNarration('deliberate stop');
    bridge.releaseController('tablet-1');
    bridge.acquireController('tablet-1');
    bridge.selectTabletStartPolicy('resume');
    const resumed = bridge.startTabletNarration('tablet-1', 'stream-2');
    expect(resumed.positionSource).toBe('restored');
    expect(resumed.acceptedCharacter).toBe(first.acceptedCharacter);
  });

  it('preserves one narration session during reconnect but defaults Stop then Start to beginning', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1, { currentTokenIndex: 4 }));
    bridge.acquireController('tablet-1');
    bridge.selectTabletPositionFromWindowsView();
    const started = bridge.startTabletNarration('tablet-1', 'stream-1');
    const reconnect = bridge.startTabletNarration('tablet-1', 'stream-2');
    expect(reconnect).toEqual(expect.objectContaining({ continued: true, narrationSessionId: started.narrationSessionId, acceptedCharacter: started.acceptedCharacter }));
    bridge.endTabletNarration('stop');
    bridge.releaseController('tablet-1');
    bridge.acquireController('tablet-1');
    const restarted = bridge.startTabletNarration('tablet-1', 'stream-3');
    expect(restarted).toEqual(expect.objectContaining({ continued: false, positionSource: 'reset', acceptedCharacter: 0 }));
  });

  it('arms a beginning startup anchor so an initial repeated transcript cannot inherit a stale location', () => {
    const bridge = new ServerSessionBridge();
    const repeated = 'studio '.repeat(180);
    bridge.applyRendererSync(sync(1, { manuscriptText: repeated, manuscriptId: 'repeated', currentTokenIndex: 150 }));
    bridge.acquireController('tablet-1');
    bridge.startTabletNarration('tablet-1', 'stream-1');
    const processed = bridge.processTabletTranscript('tablet-1', 'studio studio studio');
    expect(processed.state.currentTokenIndex).toBeLessThan(20);
  });

  it('rebases tablet authority to a manual reading-band anchor and holds old-location speech', () => {
    const bridge = new ServerSessionBridge();
    const manuscript = [
      'Opening cedar candle begins with the old narration location.',
      'Neutral filler words create meaningful distance. '.repeat(30),
      'Lantern orchard violet harbor marks the newly visible tablet section clearly.'
    ].join('\n\n');
    bridge.applyRendererSync(sync(1, { manuscriptText: manuscript, manuscriptId: 'tablet-manual' }));
    bridge.acquireController('tablet-1');
    bridge.startTabletNarration('tablet-1', 'stream-1');
    const snapshot = bridge.getSnapshot()!;
    const newCharacter = manuscript.indexOf('Lantern orchard');
    const token = snapshot.manuscript.tokens.find((candidate) =>
      candidate.characterRange.start >= newCharacter
    )!;

    const accepted = bridge.applyTabletManualReposition('tablet-1', {
      action: 'manualReposition',
      manuscriptRevision: snapshot.manuscriptRevision,
      visibleTokenIndex: token.tokenIndex,
      visibleCharacter: token.characterRange.start,
      sentenceIndex: token.sentenceIndex,
      paragraphIndex: token.paragraphIndex,
      direction: 'forward',
      inputSource: 'touch',
      scrollContainer: 'prompter-lazy-column',
      detectedAtMs: 10_000
    });

    expect(accepted).toEqual(expect.objectContaining({ accepted: true, visibleTokenIndex: token.tokenIndex }));
    expect(bridge.getState()?.manualReacquireAnchor).toEqual(expect.objectContaining({
      source: 'tablet-manual-scroll',
      visibleTokenIndex: token.tokenIndex
    }));

    const wrongSection = bridge.processTabletTranscript(
      'tablet-1',
      'Opening cedar candle begins with the old narration location'
    );
    expect(wrongSection.state.followState).toBe('holding');
    expect(wrongSection.state.manualReacquireAnchor?.visibleTokenIndex).toBe(token.tokenIndex);
    expect(wrongSection.manualReposition).toEqual({
      status: 'holding',
      anchorTokenIndex: token.tokenIndex,
      distanceTokens: wrongSection.state.currentTokenIndex - token.tokenIndex
    });

    const reacquired = bridge.processTabletTranscript(
      'tablet-1',
      'Lantern orchard violet harbor marks the newly visible tablet section clearly'
    );
    expect(reacquired.state.manualReacquireAnchor).toBeNull();
    expect(reacquired.state.currentTokenIndex).toBeGreaterThanOrEqual(token.tokenIndex);
    expect(reacquired.movement?.classification).toBe('manual scroll reacquired');
    expect(reacquired.manualReposition).toEqual({
      status: 'reacquired',
      anchorTokenIndex: token.tokenIndex,
      distanceTokens: reacquired.state.currentTokenIndex - token.tokenIndex
    });
  });

  it('keeps tablet manual status holding when coordinator target is outside tablet local tolerance', () => {
    const bridge = new ServerSessionBridge();
    const manuscript = [
      'Opening cedar candle begins near the original narration position with several words.',
      'neutral filler '.repeat(75),
      'Violet harbor lantern orchard telescope quartz marks the far target unmistakably.'
    ].join(' ');
    bridge.applyRendererSync(sync(1, { manuscriptText: manuscript, manuscriptId: 'tablet-local-tolerance' }));
    bridge.acquireController('tablet-1');
    bridge.startTabletNarration('tablet-1', 'stream-1');
    const snapshot = bridge.getSnapshot()!;
    const anchor = snapshot.manuscript.tokens[8];
    bridge.applyTabletManualReposition('tablet-1', {
      action: 'manualReposition',
      manuscriptRevision: snapshot.manuscriptRevision,
      visibleTokenIndex: anchor.tokenIndex,
      visibleCharacter: anchor.characterRange.start,
      sentenceIndex: anchor.sentenceIndex,
      paragraphIndex: anchor.paragraphIndex,
      direction: 'forward',
      inputSource: 'touch',
      scrollContainer: 'prompter-lazy-column',
      detectedAtMs: 10_000
    });

    const far = bridge.processTabletTranscript(
      'tablet-1',
      'Violet harbor lantern orchard telescope quartz marks the far target unmistakably'
    );
    expect(far.state.currentTokenIndex - anchor.tokenIndex).toBeGreaterThan(64);
    expect(far.manualReposition).toEqual({
      status: 'holding',
      anchorTokenIndex: anchor.tokenIndex,
      distanceTokens: far.state.currentTokenIndex - anchor.tokenIndex
    });

    const stillTracked = bridge.processTabletTranscript(
      'tablet-1',
      'Violet harbor lantern orchard telescope quartz marks the far target unmistakably'
    );
    expect(stillTracked.manualReposition).toEqual(expect.objectContaining({
      status: 'holding',
      anchorTokenIndex: anchor.tokenIndex
    }));
  });

  it('resets an active tablet narration to beginning when manuscript content changes', () => {
    const bridge = new ServerSessionBridge();
    bridge.applyRendererSync(sync(1, { currentTokenIndex: 4 }));
    bridge.acquireController('tablet-1');
    bridge.selectTabletPositionFromWindowsView();
    bridge.startTabletNarration('tablet-1', 'stream-1');
    bridge.applyRendererSync(sync(2, { manuscriptText: 'Replacement manuscript begins here. More words follow.', manuscriptId: 'replacement', currentTokenIndex: 4 }));
    expect(bridge.getTabletNarrationStatus()).toEqual(expect.objectContaining({ active: true, policy: 'beginning', acceptedCharacter: 0 }));
    expect(bridge.getState()?.currentTokenIndex).toBe(0);
  });
});
