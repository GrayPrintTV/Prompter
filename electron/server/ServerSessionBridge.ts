import { createHash, randomUUID } from 'node:crypto';
import { buildManuscript } from '#prompter-shared/domain/manuscript.js';
import { SessionCoordinator, type SessionCoordinatorState } from '#prompter-shared/session/SessionCoordinator.js';
import type {
  RendererSessionSync,
  RendererSyncResult,
  RecoverySource,
  TabletRecoveryClaim,
  TabletManualRepositionPayload,
  TabletManualRepositionResult,
  TabletManualRepositionStatus,
  TranscriptEventPayload
} from '#prompter-shared/protocol/messages.js';
import { runtimeSettingsFromDisplay, type RuntimeSettings } from '#prompter-shared/protocol/runtime-settings.js';
import { isAuthoritativeTargetNearTabletManualAnchor } from '#prompter-shared/domain/manualFollow.js';
import {
  NARRATION_CHECKPOINT_SCHEMA_VERSION,
  type NarrationCheckpoint
} from './NarrationCheckpointStore.js';

const EMPTY_MANUSCRIPT_ID = 'desktop-empty';

export type TabletNarrationStartPolicy = 'beginning' | 'resume' | 'windows-view';

export type RecoveryDecision = {
  source: RecoverySource;
  accepted: boolean;
  blocked: boolean;
  reason: string;
  proposedTokenIndex: number | null;
  proposedCharacter: number | null;
  acceptedTokenIndex: number | null;
  acceptedCharacter: number | null;
  manuscriptId: string;
  manuscriptHash: string;
  manuscriptRevision: number;
  narrationSessionIdBefore: string | null;
  rejectedCandidates: Array<{ source: 'tablet' | 'durable-checkpoint'; reason: string }>;
};

type PendingRecovery = {
  source: RecoverySource;
  tokenIndex: number;
  reason: string;
};

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
  creationReason: string;
  recoverySource: RecoverySource;
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
  private explicitStartPolicy: 'beginning' | 'windows-view' | null = null;
  private pendingRecovery: PendingRecovery | null = null;
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
      if (!this.controllerDeviceId && !manuscriptContentChanged) {
        const desktopAcknowledgedRecovery = this.pendingRecovery &&
          this.pendingRecovery.source !== 'tablet' &&
          sync.currentTokenIndex === this.pendingRecovery.tokenIndex;
        if (!this.pendingRecovery || desktopAcknowledgedRecovery) {
          if (desktopAcknowledgedRecovery) this.pendingRecovery = null;
          this.coordinator.setPosition(sync.currentTokenIndex, sync.followState);
        }
      }
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

  selectTabletStartPolicy(policy: TabletNarrationStartPolicy, explicit = true) {
    this.nextTabletStartPolicy = policy;
    if (explicit) {
      this.explicitStartPolicy = policy === 'beginning' ? 'beginning' : null;
      this.pendingRecovery = null;
    }
    if (policy !== 'windows-view') this.nextWindowsViewTokenIndex = null;
    return this.getTabletNarrationStatus();
  }

  selectTabletPositionFromWindowsView() {
    this.nextTabletStartPolicy = 'windows-view';
    this.nextWindowsViewTokenIndex = this.lastSync?.currentTokenIndex ?? 0;
    this.explicitStartPolicy = 'windows-view';
    this.pendingRecovery = null;
    return this.getTabletNarrationStatus();
  }

  resolveRecovery(
    deviceId: string,
    cachedManuscriptHash: string | null,
    claim: TabletRecoveryClaim | null,
    checkpoint: NarrationCheckpoint | null
  ): RecoveryDecision {
    const snapshot = this.getSnapshot();
    const manuscriptId = snapshot?.manuscript.manuscriptId ?? EMPTY_MANUSCRIPT_ID;
    const manuscriptHash = snapshot?.manuscript.contentHash ?? this.currentManuscriptHash();
    const manuscriptRevision = snapshot?.manuscriptRevision ?? 0;
    const before = this.tabletNarration?.id ?? null;
    const rejectedCandidates: RecoveryDecision['rejectedCandidates'] = [];
    const decision = (
      source: RecoverySource,
      accepted: boolean,
      blocked: boolean,
      reason: string,
      proposedTokenIndex: number | null,
      proposedCharacter: number | null,
      acceptedTokenIndex: number | null,
      acceptedCharacter: number | null
    ): RecoveryDecision => ({
      source, accepted, blocked, reason, proposedTokenIndex, proposedCharacter,
      acceptedTokenIndex, acceptedCharacter, manuscriptId, manuscriptHash,
      manuscriptRevision, narrationSessionIdBefore: before,
      rejectedCandidates: [...rejectedCandidates]
    });

    if (!snapshot || !this.coordinator) {
      return decision('no-valid-position', false, true, 'Windows has no initialized manuscript session.', null, null, null, null);
    }
    if (this.explicitStartPolicy === 'beginning') {
      this.adoptRecoveryPosition(0);
      this.pendingRecovery = { source: 'explicit-beginning', tokenIndex: 0, reason: 'Explicit Start from Beginning overrides automatic recovery.' };
      return decision('explicit-beginning', true, false, this.pendingRecovery.reason, 0, 0, 0, 0);
    }
    if (this.explicitStartPolicy === 'windows-view') {
      const tokenIndex = this.nextWindowsViewTokenIndex ?? this.lastSync?.currentTokenIndex ?? 0;
      const validation = this.validatePosition(tokenIndex, snapshot.manuscript.tokens[tokenIndex]?.characterRange.start ?? -1);
      if (validation.ok) {
        this.adoptRecoveryPosition(tokenIndex);
        this.pendingRecovery = { source: 'desktop', tokenIndex, reason: 'Explicit Windows-position handoff selected.' };
        return decision('desktop', true, false, this.pendingRecovery.reason, tokenIndex, validation.character, tokenIndex, validation.character);
      }
    }
    const claimedHash = claim?.contentHash ?? cachedManuscriptHash;
    const claimedManuscriptId = claim?.manuscriptId;
    if ((claimedHash && claimedHash !== manuscriptHash) ||
        (claimedManuscriptId && claimedManuscriptId !== manuscriptId)) {
      return decision('tablet', false, true, 'Tablet and Windows manuscript identities differ; recovery requires an existing explicit action.', claim?.tokenIndex ?? null, claim?.character ?? null, null, null);
    }
    const active = this.tabletNarration;
    if (active && active.deviceId === deviceId && active.manuscriptHash === manuscriptHash) {
      const state = this.coordinator.getState();
      return decision('tablet', true, false, 'Active same-process narration remains authoritative.', state.currentTokenIndex, state.currentCharacter, state.currentTokenIndex, state.currentCharacter);
    }
    if (this.nextTabletStartPolicy === 'resume' && this.preservedPosition?.manuscriptHash === manuscriptHash) {
      const validation = this.validatePosition(this.preservedPosition.tokenIndex, this.preservedPosition.character);
      if (validation.ok) {
        this.adoptRecoveryPosition(this.preservedPosition.tokenIndex);
        this.pendingRecovery = { source: 'tablet', tokenIndex: this.preservedPosition.tokenIndex, reason: 'Preserved same-process narration position selected for resume.' };
        return decision('tablet', true, false, this.pendingRecovery.reason, this.preservedPosition.tokenIndex, this.preservedPosition.character, this.preservedPosition.tokenIndex, validation.character);
      }
    }
    if (claim) {
      const validation = this.validateExternalPosition(claim, manuscriptHash, manuscriptId, manuscriptRevision);
      if (validation.ok) {
        this.adoptRecoveryPosition(claim.tokenIndex);
        this.pendingRecovery = { source: 'tablet', tokenIndex: claim.tokenIndex, reason: 'Validated same-manuscript tablet recovery claim.' };
        return decision('tablet', true, false, this.pendingRecovery.reason, claim.tokenIndex, claim.character, claim.tokenIndex, validation.character);
      }
      rejectedCandidates.push({ source: 'tablet', reason: validation.reason });
    }
    if (checkpoint) {
      const validation = this.validateExternalPosition(checkpoint, manuscriptHash, manuscriptId, manuscriptRevision);
      if (validation.ok) {
        this.adoptRecoveryPosition(checkpoint.tokenIndex);
        this.pendingRecovery = { source: 'durable-checkpoint', tokenIndex: checkpoint.tokenIndex, reason: 'Validated durable narration checkpoint.' };
        return decision('durable-checkpoint', true, false, this.pendingRecovery.reason, checkpoint.tokenIndex, checkpoint.character, checkpoint.tokenIndex, validation.character);
      }
      rejectedCandidates.push({ source: 'durable-checkpoint', reason: validation.reason });
    }
    const desktopToken = this.lastSync?.currentTokenIndex;
    if (desktopToken !== undefined) {
      const validation = this.validatePosition(desktopToken, snapshot.manuscript.tokens[desktopToken]?.characterRange.start ?? -1);
      if (validation.ok) {
        this.adoptRecoveryPosition(desktopToken);
        this.pendingRecovery = { source: 'desktop', tokenIndex: desktopToken, reason: 'Current desktop position is the first valid fallback.' };
        return decision('desktop', true, false, this.pendingRecovery.reason, desktopToken, validation.character, desktopToken, validation.character);
      }
    }
    this.adoptRecoveryPosition(0);
    this.pendingRecovery = { source: 'no-valid-position', tokenIndex: 0, reason: 'No valid tablet, checkpoint, or desktop position exists.' };
    return decision('no-valid-position', true, false, this.pendingRecovery.reason, null, null, 0, 0);
  }

  startTabletNarration(deviceId: string, streamId: string, forcedPolicy?: TabletNarrationStartPolicy): TabletNarrationStartResult {
    if (!this.coordinator || this.controllerDeviceId !== deviceId) throw new Error('Tablet does not own the controller lease.');
    const manuscriptHash = this.currentManuscriptHash();
    const active = this.tabletNarration;
    if (active && active.deviceId === deviceId && active.manuscriptHash === manuscriptHash) {
      active.streamId = streamId;
      return this.narrationResult(active, true, 'preserved', 'active same-device same-manuscript narration session', 'tablet');
    }
    const recoveryPolicy = this.pendingRecovery?.source === 'desktop'
      ? 'windows-view'
      : this.pendingRecovery?.source === 'explicit-beginning' || this.pendingRecovery?.source === 'no-valid-position'
        ? 'beginning'
        : this.pendingRecovery ? 'resume' : null;
    const policy = forcedPolicy ?? recoveryPolicy ?? this.nextTabletStartPolicy;
    const creationReason = !active
      ? `no active narration session; applying ${policy} policy`
      : active.deviceId !== deviceId
        ? `controller changed from ${active.deviceId} to ${deviceId}`
        : 'manuscript content changed';
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
    this.explicitStartPolicy = null;
    this.pendingRecovery = null;
    this.emit();
    return this.narrationResult(this.tabletNarration, false, selection.positionSource, creationReason, selection.recoverySource);
  }

  createCheckpoint(
    tokenIndex = this.coordinator?.getState().currentTokenIndex ?? -1,
    savedAtMs = Date.now(),
    character?: number
  ): NarrationCheckpoint | null {
    const snapshot = this.getSnapshot();
    if (!snapshot) return null;
    const current = this.coordinator?.getState();
    const proposedCharacter = character ??
      (current?.currentTokenIndex === tokenIndex ? current.currentCharacter : undefined) ??
      snapshot.manuscript.tokens[tokenIndex]?.characterRange.start ?? -1;
    const validation = this.validatePosition(tokenIndex, proposedCharacter);
    if (!validation.ok) return null;
    const token = snapshot.manuscript.tokens[tokenIndex];
    return {
      schemaVersion: NARRATION_CHECKPOINT_SCHEMA_VERSION,
      manuscriptId: snapshot.manuscript.manuscriptId,
      manuscriptHash: snapshot.manuscript.contentHash,
      manuscriptRevision: snapshot.manuscriptRevision,
      tokenIndex,
      character: validation.character,
      sentenceIndex: token.sentenceIndex,
      paragraphIndex: token.paragraphIndex,
      anchorFingerprint: this.anchorFingerprint(tokenIndex),
      savedAtMs
    };
  }

  createDesktopNarrationCheckpoint(savedAtMs = Date.now()) {
    if (this.controllerDeviceId || this.pendingRecovery?.source === 'tablet') return null;
    return this.createCheckpoint(undefined, savedAtMs);
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
      state.manualReacquireAnchor?.source !== 'tablet-manual-scroll' &&
      state.movementDecision?.classification === 'manual scroll reacquired' &&
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
    if (this.pendingRecovery) {
      return {
        tokenIndex: this.pendingRecovery.tokenIndex,
        positionSource: this.pendingRecovery.source === 'tablet' ? 'restored' as const :
          this.pendingRecovery.source === 'desktop' ? 'windows-view' as const :
          this.pendingRecovery.source === 'explicit-beginning' || this.pendingRecovery.source === 'no-valid-position' ? 'reset' as const : 'restored' as const,
        recoverySource: this.pendingRecovery.source
      };
    }
    if (policy === 'resume' && this.preservedPosition?.manuscriptHash === manuscriptHash) {
      return { tokenIndex: this.preservedPosition.tokenIndex, positionSource: 'restored' as const, recoverySource: 'tablet' as const };
    }
    if (policy === 'windows-view') {
      return { tokenIndex: this.nextWindowsViewTokenIndex ?? this.lastSync?.currentTokenIndex ?? 0, positionSource: 'windows-view' as const, recoverySource: 'desktop' as const };
    }
    return { tokenIndex: 0, positionSource: 'reset' as const, recoverySource: 'explicit-beginning' as const };
  }

  private narrationResult(
    narration: TabletNarrationSession,
    continued: boolean,
    positionSource: TabletNarrationStartResult['positionSource'],
    creationReason: string,
    recoverySource: RecoverySource
  ): TabletNarrationStartResult {
    const state = this.coordinator!.getState();
    return {
      narrationSessionId: narration.id, continued, policy: narration.policy, positionSource,
      streamId: narration.streamId, leaseId: `controller-${narration.deviceId}`,
      manuscriptHash: narration.manuscriptHash, acceptedCharacter: state.currentCharacter,
      estimatedCharacter: state.alignment.tokenIndex >= 0 ? state.currentCharacter : 0,
      paragraphIndex: state.currentParagraphIndex,
      lastAcceptedTranscriptAtMs: narration.lastAcceptedTranscriptAtMs,
      creationReason,
      recoverySource
    };
  }

  private adoptRecoveryPosition(tokenIndex: number) {
    if (!this.coordinator) return;
    if (this.coordinator.getState().currentTokenIndex === tokenIndex) return;
    this.coordinator.setPosition(tokenIndex, 'following');
    this.coordinator.resetTranscriptContext();
    this.emit();
  }

  private validateExternalPosition(
    candidate: Pick<NarrationCheckpoint, 'manuscriptId' | 'manuscriptHash' | 'manuscriptRevision' | 'tokenIndex' | 'character' | 'sentenceIndex' | 'paragraphIndex' | 'anchorFingerprint'> |
      TabletRecoveryClaim,
    manuscriptHash: string,
    manuscriptId: string,
    manuscriptRevision: number
  ): { ok: true; character: number } | { ok: false; reason: string } {
    const candidateHash = 'contentHash' in candidate ? candidate.contentHash : candidate.manuscriptHash;
    if (candidateHash !== manuscriptHash) return { ok: false, reason: 'wrong-manuscript hash' };
    if (candidate.manuscriptId !== manuscriptId) return { ok: false, reason: 'wrong manuscript identity' };
    if (candidate.manuscriptRevision !== manuscriptRevision) return { ok: false, reason: 'stale manuscript revision' };
    const validation = this.validatePosition(candidate.tokenIndex, candidate.character);
    if (!validation.ok) return validation;
    const snapshot = this.getSnapshot()!;
    const token = snapshot.manuscript.tokens[candidate.tokenIndex];
    if (token.sentenceIndex !== candidate.sentenceIndex || token.paragraphIndex !== candidate.paragraphIndex) {
      return { ok: false, reason: 'structural anchor mismatch' };
    }
    if (this.anchorFingerprint(candidate.tokenIndex) !== candidate.anchorFingerprint) {
      return { ok: false, reason: 'nearby text fingerprint mismatch' };
    }
    return validation;
  }

  private validatePosition(tokenIndex: number, character: number): { ok: true; character: number } | { ok: false; reason: string } {
    const snapshot = this.getSnapshot();
    if (!snapshot || !Number.isSafeInteger(tokenIndex) || !Number.isSafeInteger(character)) return { ok: false, reason: 'position is not initialized' };
    const token = snapshot.manuscript.tokens[tokenIndex];
    if (!token) return { ok: false, reason: 'token index is out of range' };
    if (character < token.characterRange.start || character > token.characterRange.end) return { ok: false, reason: 'character is inconsistent with token' };
    return { ok: true, character };
  }

  private anchorFingerprint(tokenIndex: number) {
    const snapshot = this.getSnapshot()!;
    const tokens = snapshot.manuscript.tokens;
    const first = tokens[Math.max(0, tokenIndex - 8)];
    const last = tokens[Math.min(tokens.length - 1, tokenIndex + 8)];
    const nearby = snapshot.manuscript.normalizedContent.slice(first.characterRange.start, last.characterRange.end);
    return `sha256:${createHash('sha256').update(nearby).digest('hex')}`;
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
