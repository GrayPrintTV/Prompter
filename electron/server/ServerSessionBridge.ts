import { createHash } from 'node:crypto';
import { buildManuscript } from '#prompter-shared/domain/manuscript.js';
import { SessionCoordinator, type SessionCoordinatorState } from '#prompter-shared/session/SessionCoordinator.js';
import type {
  RendererSessionSync,
  RendererSyncResult,
  TranscriptEventPayload
} from '#prompter-shared/protocol/messages.js';

const EMPTY_MANUSCRIPT_ID = 'desktop-empty';

export class ServerSessionBridge {
  private coordinator: SessionCoordinator | null = null;
  private lastRendererRevision = -1;
  private lastFingerprint = '';
  private lastSync: RendererSessionSync | null = null;
  private controllerDeviceId: string | null = null;
  private readonly listeners = new Set<(state: SessionCoordinatorState) => void>();

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

    const manuscriptChanged = !this.lastSync || sync.manuscriptText !== this.lastSync.manuscriptText || sync.manuscriptId !== this.lastSync.manuscriptId;
    if (!this.coordinator) {
      this.coordinator = new SessionCoordinator({
        manuscript: buildManuscript(sync.manuscriptText),
        currentTokenIndex: sync.currentTokenIndex,
        followState: sync.followState,
        displaySettings: sync.displaySettings
      });
    } else {
      this.coordinator.setDisplaySettings(sync.displaySettings);
      if (manuscriptChanged) this.coordinator.replaceManuscript(buildManuscript(sync.manuscriptText), sync.currentTokenIndex);
      // While a tablet owns transcript authority, renderer synchronization may update manuscript/settings
      // but must not overwrite the accepted tablet position with an older desktop projection.
      if (!this.controllerDeviceId) this.coordinator.setPosition(sync.currentTokenIndex, sync.followState);
    }

    if (sync.sessionResetId !== this.lastSync?.sessionResetId) this.coordinator.resetTranscriptContext();
    this.lastRendererRevision = sync.rendererRevision;
    this.lastFingerprint = fingerprint;
    this.lastSync = structuredClone(sync);
    this.emit();
    return this.result(true, false, false, manuscriptChanged ? 'Manuscript/session synchronized.' : 'Session state synchronized.');
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
    this.emit();
    return true;
  }

  releaseController(deviceId?: string) {
    if (deviceId && this.controllerDeviceId !== deviceId) return false;
    this.controllerDeviceId = null;
    this.emit();
    return true;
  }

  getControllerDeviceId() {
    return this.controllerDeviceId;
  }

  processTabletTranscript(deviceId: string, text: string, audioSequence?: number) {
    if (!this.coordinator || this.controllerDeviceId !== deviceId) throw new Error('Tablet does not own the controller lease.');
    const processed = this.coordinator.processTranscript({
      text,
      isFinal: true,
      timestampMs: Date.now(),
      source: 'local-whisper'
    });
    this.emit();
    const state = processed.state;
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
    return { state, transcript, movement: state.movementDecision };
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
      controllerLease: this.controllerDeviceId
        ? { deviceId: this.controllerDeviceId, leaseId: `controller-${this.controllerDeviceId}` }
        : null
    };
  }

  onState(callback: (state: SessionCoordinatorState) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
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
