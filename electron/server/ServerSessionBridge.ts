import { createHash, randomUUID } from 'node:crypto';
import { buildManuscript } from '#prompter-shared/domain/manuscript.js';
import { SessionCoordinator, type SessionCoordinatorState } from '#prompter-shared/session/SessionCoordinator.js';
import type {
  RendererSessionSync,
  RendererSyncResult,
  TabletManualRepositionPayload,
  TabletManualRepositionResult,
  TabletManualRepositionStatus,
  TranscriptEventPayload
} from '#prompter-shared/protocol/messages.js';
import { runtimeSettingsFromDisplay, type RuntimeSettings } from '#prompter-shared/protocol/runtime-settings.js';
import { isAuthoritativeTargetNearTabletManualAnchor } from '#prompter-shared/domain/manualFollow.js';

const EMPTY_MANUSCRIPT_ID = 'desktop-empty';

export type TabletNarrationStartPolicy = 'beginning' | 'resume' | 'windows-view';

type PreservedPosition = {
  manuscriptHash: string;
  tokenIndex: number;
  character: number;
  paragraphIndex: number;
  savedAtMs: number;
};

type TabletNarrationSession = {
  id: string;
  deviceId: string;
  streamId: string;
  manuscriptHash: string;
  policy: TabletNarrationStartPolicy;
  startedAtMs: number;
  startingTokenIndex: number;
  startingCharacter: number;
  lastAcceptedTranscriptAtMs: number | null;
};

type PendingTabletManualReposition = {
  deviceId: string;
  anchorTokenIndex: number;
  anchorCharacter: number;
  anchorSentenceIndex: number;
  anchorParagraphIndex: number;
  manuscriptRevision: number;
};

export type TabletNarrationStartResult = {
  narrationSessionId: string;
  continued: boolean;
  policy: TabletNarrationStartPolicy;
  positionSource: 'reset' | 'restored' | 'windows-view' | 'preserved';
  streamId: string;
  leaseId: string;
  manuscriptHash: string;
  acceptedCharacter: number;
  estimatedCharacter: number;
  paragraphIndex: number;
  lastAcceptedTranscriptAtMs: number | null;
};

export class ServerSessionBridge {
  private coordinator: SessionCoordinator | null = null;
  private lastRendererRevision = -1;
  private lastFingerprint = '';
  private lastSync: RendererSessionSync | null = null;
  private controllerDeviceId: string | null = null;
  private sessionId = randomUUID();
  private nextTabletStartPolicy: TabletNarrationStartPolicy = 'beginning';
  private nextWindowsViewTokenIndex: number | null = null;
  private tabletNarration: TabletNarrationSession | null = null;
  private preservedPosition: PreservedPosition | null = null;
  private settingsRevision = 0;
  private runtimeSettings: RuntimeSettings | null = null;
  private pendingTabletManualReposition: PendingTabletManualReposition | null = null;
  private readonly listeners = new Set<(state: SessionCoordinatorState) => void>();
  private readonly controllerListeners = new Set<(deviceId: string | null) => void>();
  private readonly runtimeSettingsListeners = new Set<(settings: RuntimeSettings) => void>();

  applyRendererSync(sync: RendererSessionSync): RendererSyncResult {
    const fingerprint = this.fingerprint(sync);
    if (sync.rendererRevision < this.lastRendererRevision) {
      return this.result(false, false, true, 'Renderer revision is stale.');
    }
    if (fingerprint === this.lastFingerprint) {
      this.lastRendererRevision = Math.max(this.lastRendererRevision, sync.rendererRevision);
      return this.result(true, true, false, 'Duplicate renderer state suppressed.');
    }
    if (sync.rendererRevision === this.lastRendererRevision) {
      return this.result(false, false, true, 'Renderer revision was reused with different state.');
    }

    const manuscriptContentChanged = !this.lastSync || sync.manuscriptText !== this.lastSync.manuscriptText;
    const manuscriptIdentityChanged = !this.lastSync || sync.manuscriptId !== this.lastSync.manuscriptId;
    const displaySettingsChanged = !this.lastSync || JSON.stringify(sync.displaySettings) !== JSON.stringify(this.lastSync.displaySettings);
    if (!this.coordinator) {
      this.coordinator = new SessionCoordinator({
        manuscript: buildManuscript(sync.manuscriptText),
        currentTokenIndex: sync.currentTokenIndex,
        followState: sync.followState,
        displaySettings: sync.displaySettings
      });
    } else {
      this.coordinator.setDisplaySettings(sync.displaySettings);
      if (manuscriptContentChanged) this.coordinator.replaceManuscript(buildManuscript(sync.manuscriptText), 0);
      // While a tablet owns transcript authority, renderer synchronization may update manuscript/settings
      // but must not overwrite the accepted tablet position with an older desktop projection.
      if (!this.controllerDeviceId && !manuscriptContentChanged) this.coordinator.setPosition(sync.currentTokenIndex, sync.followState);
    }

    if (this.lastSync && sync.sessionResetId !== this.lastSync.sessionResetId) {
      this.sessionId = randomUUID();
      this.coordinator.resetTranscriptContext();
    }
    this.lastRendererRevision = sync.rendererRevision;
    this.lastFingerprint = fingerprint;
    this.lastSync = structuredClone(sync);
    if (displaySettingsChanged) {
      this.settingsRevision += 1;
      this.runtimeSettings = runtimeSettingsFromDisplay(sync.displaySettings, this.settingsRevision);
      this.emitRuntimeSettings();
    }
    if (manuscriptContentChanged) {
      this.pendingTabletManualReposition = null;
      this.preservedPosition = null;
      const activeNarration = this.tabletNarration;
      this.tabletNarration = null;
      if (activeNarration && this.controllerDeviceId) this.startTabletNarration(this.controllerDeviceId, activeNarration.streamId, 'beginning');
    }
    this.emit();
    return this.result(true, false, false, manuscriptContentChanged || manuscriptIdentityChanged ? 'Manuscript/session synchronized.' : 'Session state synchronized.');
  }

  hasSession() {
    return this.coordinator !== null;
  }

  canAcquireTabletController() {
    return Boolean(this.coordinator && !this.lastSync?.transcriptSourceActive);
  }

  acquireController(deviceId: string) {
    if (!this.canAcquireTabletController()) return false;
    if (this.controllerDeviceId && this.controllerDeviceId !== deviceId) return false;
    this.controllerDeviceId = deviceId;
    if (this.coordinator?.getState().followState === 'manual') this.coordinator.setFollowState('following');
    this.emitController();
    this.emit();
    return true;
  }

  releaseController(deviceId?: string) {
    if (deviceId && this.controllerDeviceId !== deviceId) return false;
    this.controllerDeviceId = null;
    this.pendingTabletManualReposition = null;
    this.emitController();
    this.emit();
    return true;
  }

  getControllerDeviceId() {
    return this.controllerDeviceId;
  }

  getSessionId() { return this.sessionId; }

  selectTabletStartPolicy(policy: TabletNarrationStartPolicy) {
    this.nextTabletStartPolicy = policy;
    if (policy !== 'windows-view') this.nextWindowsViewTokenIndex = null;
    return this.getTabletNarrationStatus();
  }

  selectTabletPositionFromWindowsView() {
    this.nextTabletStartPolicy = 'windows-view';
    this.nextWindowsViewTokenIndex = this.lastSync?.currentTokenIndex ?? 0;
    return this.getTabletNarrationStatus();
  }

  startTabletNarration(deviceId: string, streamId: string, forcedPolicy?: TabletNarrationStartPolicy): TabletNarrationStartResult {
    if (!this.coordinator || this.controllerDeviceId !== deviceId) throw new Error('Tablet does not own the controller lease.');
    const manuscriptHash = this.currentManuscriptHash();
    const active = this.tabletNarration;
    if (active && active.deviceId === deviceId && active.manuscriptHash === manuscriptHash) {
      return this.narrationResult(active, true, 'preserved');
    }
    const policy = forcedPolicy ?? this.nextTabletStartPolicy;
    this.pendingTabletManualReposition = null;
    const selection = this.selectStartingToken(policy, manuscriptHash);
    this.coordinator.setPosition(selection.tokenIndex, 'following');
    this.coordinator.resetTranscriptContext();
    this.coordinator.setVisibleReacquireAnchor({
      source: 'startup', visibleTokenIndex: selection.tokenIndex, detectedAtMs: Date.now(),
      direction: 'stationary', hadFreshConfirmedAnchor: false
    }, 'startup');
    const state = this.coordinator.getState();
    this.tabletNarration = {
      id: randomUUID(), deviceId, streamId, manuscriptHash, policy, startedAtMs: Date.now(),
      startingTokenIndex: state.currentTokenIndex, startingCharacter: state.currentCharacter,
      lastAcceptedTranscriptAtMs: null
    };
    this.nextTabletStartPolicy = 'beginning';
    this.nextWindowsViewTokenIndex = null;
    this.emit();
    return this.narrationResult(this.tabletNarration, false, selection.positionSource);
  }

  endTabletNarration(reason: string) {
    const narration = this.tabletNarration;
    if (!narration || !this.coordinator) return null;
    const state = this.coordinator.getState();
    this.preservedPosition = {
      manuscriptHash: narration.manuscriptHash, tokenIndex: state.currentTokenIndex,
      character: state.currentCharacter, paragraphIndex: state.currentParagraphIndex, savedAtMs: Date.now()
    };
    this.tabletNarration = null;
    this.pendingTabletManualReposition = null;
    return { reason, preserved: { ...this.preservedPosition } };
  }

  getTabletNarrationStatus() {
    const narration = this.tabletNarration;
    const state = this.coordinator?.getState();
    const requestedPolicy = this.nextTabletStartPolicy;
    const resumeAvailable = Boolean(this.preservedPosition && this.preservedPosition.manuscriptHash === this.currentManuscriptHash());
    const nextDescription = requestedPolicy === 'resume' && resumeAvailable
      ? `Tablet will resume near character ${this.preservedPosition!.character}`
      : requestedPolicy === 'windows-view'
        ? `Tablet will start from the current Windows selection`
        : `Tablet will start at manuscript beginning`;
    return {
      active: Boolean(narration), narrationSessionId: narration?.id ?? null,
      streamId: narration?.streamId ?? null, policy: narration?.policy ?? requestedPolicy,
      startDescription: narration
        ? `Tablet narration started near character ${narration.startingCharacter}`
        : nextDescription,
      acceptedCharacter: state?.currentCharacter ?? 0,
      lastAcceptedTranscriptAtMs: narration?.lastAcceptedTranscriptAtMs ?? null,
      resumeAvailable
    };
  }

  onController(callback: (deviceId: string | null) => void) {
    this.controllerListeners.add(callback);
    return () => this.controllerListeners.delete(callback);
  }

  processTabletTranscript(deviceId: string, text: string, audioSequence?: number) {
    if (!this.coordinator || this.controllerDeviceId !== deviceId) throw new Error('Tablet does not own the controller lease.');
    const coordinatorStateBefore = this.coordinator.getState();
    const coordinatorTabletAnchor = coordinatorStateBefore.manualReacquireAnchor?.source === 'tablet-manual-scroll'
      ? coordinatorStateBefore.manualReacquireAnchor
      : null;
    const trackedTabletAnchor = this.pendingTabletManualReposition?.deviceId === deviceId &&
      this.pendingTabletManualReposition.manuscriptRevision === coordinatorStateBefore.manuscriptRevision
      ? this.pendingTabletManualReposition
      : null;
    const pendingAnchorTokenIndex = trackedTabletAnchor?.anchorTokenIndex ?? coordinatorTabletAnchor?.visibleTokenIndex ?? null;
    const processed = this.coordinator.processTranscript({
      text,
      isFinal: true,
      timestampMs: Date.now(),
      source: 'local-whisper'
    });
    if (this.tabletNarration?.deviceId === deviceId) this.tabletNarration.lastAcceptedTranscriptAtMs = Date.now();
    this.emit();
    let state = processed.state;
    const manualAnchorDistanceTokens = pendingAnchorTokenIndex === null
      ? null
      : state.currentTokenIndex - pendingAnchorTokenIndex;
    const manualReacquired = trackedTabletAnchor !== null &&
      isAuthoritativeTargetNearTabletManualAnchor(
        {
          tokenIndex: trackedTabletAnchor.anchorTokenIndex,
          character: trackedTabletAnchor.anchorCharacter,
          sentenceIndex: trackedTabletAnchor.anchorSentenceIndex,
          paragraphIndex: trackedTabletAnchor.anchorParagraphIndex
        },
        {
          tokenIndex: state.currentTokenIndex,
          character: state.currentCharacter,
          sentenceIndex: state.currentSentenceIndex,
          paragraphIndex: state.currentParagraphIndex
        }
      );
    if (manualReacquired) {
      this.pendingTabletManualReposition = null;
      if (state.manualReacquireAnchor?.source === 'tablet-manual-scroll') {
        this.coordinator.clearVisibleReacquireAnchor();
        state = this.coordinator.getState();
      }
    }
    const transcript: TranscriptEventPayload = {
      sessionRevision: state.sessionRevision,
      manuscriptRevision: state.manuscriptRevision,
      text,
      isFinal: true,
      source: 'local-whisper',
      audioSequence,
      timestampMs: Date.now(),
      acceptedPosition: {
        tokenIndex: state.currentTokenIndex,
        character: state.currentCharacter,
        sentenceIndex: state.currentSentenceIndex,
        paragraphIndex: state.currentParagraphIndex
        }
      };
    const manualReposition: TabletManualRepositionStatus | null = pendingAnchorTokenIndex !== null
      ? {
          status: manualReacquired ? 'reacquired' : 'holding',
          anchorTokenIndex: pendingAnchorTokenIndex,
          distanceTokens: manualAnchorDistanceTokens!
        }
      : null;
    return { state, transcript, movement: state.movementDecision, manualReposition };
  }

  applyTabletManualReposition(
    deviceId: string,
    payload: TabletManualRepositionPayload
  ): TabletManualRepositionResult {
    if (!this.coordinator || this.controllerDeviceId !== deviceId) {
      throw new Error('Tablet does not own the controller lease.');
    }
    const state = this.coordinator.getState();
    const snapshot = this.getSnapshot();
    const reject = (reason: string): TabletManualRepositionResult => ({
      accepted: false,
      reason,
      manuscriptRevision: state.manuscriptRevision,
      visibleTokenIndex: payload.visibleTokenIndex,
      sessionRevision: state.sessionRevision
    });
    if (!snapshot || payload.manuscriptRevision !== state.manuscriptRevision) {
      return reject('Tablet manual anchor used a stale manuscript revision.');
    }
    const token = snapshot.manuscript.tokens[payload.visibleTokenIndex];
    if (!token || token.tokenIndex !== payload.visibleTokenIndex) {
      return reject('Tablet manual anchor token is outside the active manuscript.');
    }
    if (
      token.sentenceIndex !== payload.sentenceIndex ||
      token.paragraphIndex !== payload.paragraphIndex ||
      payload.visibleCharacter < token.characterRange.start ||
      payload.visibleCharacter > token.characterRange.end
    ) {
      return reject('Tablet manual anchor metadata does not match the active manuscript token.');
    }

    const next = this.coordinator.setVisibleReacquireAnchor({
      source: 'tablet-manual-scroll',
      visibleTokenIndex: payload.visibleTokenIndex,
      detectedAtMs: payload.detectedAtMs,
      direction: payload.direction,
      hadFreshConfirmedAnchor: this.coordinator.hasFreshAnchor()
    }, 'manual');
    this.pendingTabletManualReposition = {
      deviceId,
      anchorTokenIndex: payload.visibleTokenIndex,
      anchorCharacter: payload.visibleCharacter,
      anchorSentenceIndex: payload.sentenceIndex,
      anchorParagraphIndex: payload.paragraphIndex,
      manuscriptRevision: next.manuscriptRevision
    };
    this.emit();
    return {
      accepted: true,
      reason: 'Coordinator accepted manual anchor from tablet; waiting for nearby transcript evidence.',
      manuscriptRevision: next.manuscriptRevision,
      visibleTokenIndex: payload.visibleTokenIndex,
      sessionRevision: next.sessionRevision
    };
  }

  getState() {
    return this.coordinator?.getState() ?? null;
  }

  getSnapshot() {
    if (!this.coordinator) return null;
    const manuscriptText = this.lastSync?.manuscriptText ?? '';
    const snapshot = this.coordinator.toSerializableSnapshot({
      manuscriptId: this.lastSync?.manuscriptId || EMPTY_MANUSCRIPT_ID,
      contentHash: `sha256:${createHash('sha256').update(manuscriptText).digest('hex')}`
    });
    return {
      ...snapshot,
      runtimeSettings: this.getRuntimeSettings(),
      narrationSessionId: this.tabletNarration?.id ?? null,
      controllerLease: this.controllerDeviceId
        ? { deviceId: this.controllerDeviceId, leaseId: `controller-${this.controllerDeviceId}` }
        : null
    };
  }

  onState(callback: (state: SessionCoordinatorState) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onRuntimeSettings(callback: (settings: RuntimeSettings) => void) {
    this.runtimeSettingsListeners.add(callback);
    return () => this.runtimeSettingsListeners.delete(callback);
  }

  getRuntimeSettings() {
    if (this.runtimeSettings) return this.runtimeSettings;
    if (!this.lastSync) return null;
    this.settingsRevision = Math.max(1, this.settingsRevision);
    this.runtimeSettings = runtimeSettingsFromDisplay(this.lastSync.displaySettings, this.settingsRevision);
    return this.runtimeSettings;
  }

  getAuthority() {
    if (this.controllerDeviceId) return 'tablet' as const;
    if (this.lastSync?.transcriptSourceActive) return 'desktop' as const;
    return 'manual' as const;
  }

  private result(accepted: boolean, duplicate: boolean, stale: boolean, reason: string): RendererSyncResult {
    const state = this.coordinator?.getState();
    return {
      accepted,
      duplicate,
      stale,
      serverSessionRevision: state?.sessionRevision ?? 0,
      manuscriptRevision: state?.manuscriptRevision ?? 0,
      reason
    };
  }

  private emit() {
    if (!this.coordinator) return;
    const state = this.coordinator.getState();
    for (const listener of this.listeners) listener(state);
  }

  private emitController() {
    for (const listener of this.controllerListeners) listener(this.controllerDeviceId);
  }

  private emitRuntimeSettings() {
    if (!this.runtimeSettings) return;
    for (const listener of this.runtimeSettingsListeners) listener(this.runtimeSettings);
  }

  private currentManuscriptHash() {
    return `sha256:${createHash('sha256').update(this.lastSync?.manuscriptText ?? '').digest('hex')}`;
  }

  private selectStartingToken(policy: TabletNarrationStartPolicy, manuscriptHash: string) {
    if (policy === 'resume' && this.preservedPosition?.manuscriptHash === manuscriptHash) {
      return { tokenIndex: this.preservedPosition.tokenIndex, positionSource: 'restored' as const };
    }
    if (policy === 'windows-view') {
      return { tokenIndex: this.nextWindowsViewTokenIndex ?? this.lastSync?.currentTokenIndex ?? 0, positionSource: 'windows-view' as const };
    }
    return { tokenIndex: 0, positionSource: 'reset' as const };
  }

  private narrationResult(narration: TabletNarrationSession, continued: boolean, positionSource: TabletNarrationStartResult['positionSource']): TabletNarrationStartResult {
    const state = this.coordinator!.getState();
    return {
      narrationSessionId: narration.id, continued, policy: narration.policy, positionSource,
      streamId: narration.streamId, leaseId: `controller-${narration.deviceId}`,
      manuscriptHash: narration.manuscriptHash, acceptedCharacter: state.currentCharacter,
      estimatedCharacter: state.alignment.tokenIndex >= 0 ? state.currentCharacter : 0,
      paragraphIndex: state.currentParagraphIndex,
      lastAcceptedTranscriptAtMs: narration.lastAcceptedTranscriptAtMs
    };
  }

  private fingerprint(sync: RendererSessionSync) {
    return createHash('sha256').update(JSON.stringify({
      manuscriptText: sync.manuscriptText,
      manuscriptId: sync.manuscriptId,
      currentTokenIndex: sync.currentTokenIndex,
      followState: sync.followState,
      displaySettings: sync.displaySettings,
      selectedProviderId: sync.selectedProviderId,
      transcriptSourceActive: sync.transcriptSourceActive,
      sessionResetId: sync.sessionResetId
    })).digest('hex');
  }
}
