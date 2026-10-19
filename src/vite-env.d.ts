/// <reference types="vite/client" />

import type {
  ElectronBridgeDiagnostics,
  LiveAsrConfigStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTelemetryAggregate,
  LocalWhisperTranscriptResult,
  MainPreloadError,
  OpenAiRealtimeSdpAnswer
} from './domain/types';
import type {
  RendererSessionSync,
  RendererSyncResult,
  ServerCoordinatorUpdate,
  ServerStatusSummary,
  TabletModeStatus,
  UsbTransportMode,
  UsbTransportStatus
} from '../shared/protocol/messages';
import type { StructuredDiagnosticEvent } from '../shared/protocol/diagnostics';
import type { PrepDraft, PrepOperationResult, PrepProjectSummary, PrepReviewOperation } from '../shared/manuscriptPrep/types';

type ImportedManuscriptFile = {
  filePath: string;
  name: string;
  text: string;
  format: 'text' | 'docx' | 'pdf';
};

declare global {
  interface Window {
    __prompterMainPreloadError?: MainPreloadError;
    prompterPreloadDiagnostics?: {
      getDiagnostics(): {
        started: boolean;
        exposed: boolean;
        errorMessage: string | null;
        errorStack: string | null;
      };
    };
    prompterApi?: {
      ping(): string;
      openManuscriptFile(): Promise<ImportedManuscriptFile | null>;
      openTextFile(): Promise<ImportedManuscriptFile | null>;
      importPrepTxt(projectId: string): Promise<{ inspected: PrepOperationResult<unknown>; extracted: PrepOperationResult<unknown> | null } | null>;
      getPrepDraft(projectId: string, draftId: string): Promise<PrepOperationResult<PrepDraft>>;
      applyPrepReviewChange(projectId: string, draftId: string, expectedRevision: number, operation: PrepReviewOperation, idempotencyKey?: string): Promise<PrepOperationResult<{ revision: number }>>;
      approvePrepDraft(projectId: string, draftId: string, expectedRevision: number, idempotencyKey?: string): Promise<PrepOperationResult<unknown>>;
      cancelPrepRequest(projectId: string, requestId: string): Promise<PrepOperationResult<unknown>>;
      getPrepProjectSummary(projectId: string): Promise<PrepProjectSummary>;
      readPrepApproved(projectId: string, approvedId: string): Promise<import('../shared/manuscriptPrep/types').PrepApproved & { projectId: string; text: string }>;
      exportPrepApproved(projectId: string, approvedId: string): Promise<unknown>;
      getPrepActiveProjectId(): Promise<string>;
      toggleFullScreen(): Promise<boolean>;
      toggleAlwaysOnTop(): Promise<boolean>;
      quitApp(): Promise<boolean>;
      getOpenAiRealtimeConfigStatus(): Promise<LiveAsrConfigStatus>;
      exchangeOpenAiRealtimeSdp(offerSdp: string): Promise<OpenAiRealtimeSdpAnswer>;
      getBridgeDiagnostics(): Promise<ElectronBridgeDiagnostics>;
      getLocalWhisperStatus(): Promise<LocalWhisperStatus>;
      startLocalWhisper(settings: LocalWhisperSettings): Promise<LocalWhisperStatus>;
      stopLocalWhisper(): Promise<LocalWhisperStatus>;
      recordLocalWhisperTelemetry(aggregate: LocalWhisperTelemetryAggregate): Promise<boolean>;
      transcribeLocalWhisperChunk(payload: {
        audioData: ArrayBuffer;
        mimeType: string;
        format: string;
        extension: string;
        sampleRate?: number;
        durationSeconds?: number;
        headerSignature?: string;
        telemetry?: {
          capturedAtMs: number;
          audioDurationMs: number;
          rendererDispatchedAtMs: number;
        };
        settings: LocalWhisperSettings;
      }): Promise<LocalWhisperTranscriptResult>;
      syncServerSession(payload: RendererSessionSync): Promise<RendererSyncResult>;
      getServerStatus(): Promise<ServerStatusSummary | null>;
      getServerDiagnostics(): Promise<unknown>;
      prepareTablet(): Promise<ServerStatusSummary>;
      setTabletUsbMode(mode: UsbTransportMode): Promise<UsbTransportStatus | null>;
      selectTabletUsbDevice(serial: string | null): Promise<UsbTransportStatus | null>;
      retryTabletUsb(): Promise<UsbTransportStatus | null>;
      getTabletLogEvents(): Promise<StructuredDiagnosticEvent[]>;
      copyTabletLog(events: StructuredDiagnosticEvent[]): Promise<void>;
      clearTabletLogView(): Promise<void>;
      openTabletLogFolder(): Promise<void>;
      saveTabletDiagnosticBundle(): Promise<string | null>;
      onTabletLogEvent(callback: (event: StructuredDiagnosticEvent) => void): () => void;
      onServerStatus(callback: (status: ServerStatusSummary) => void): () => void;
      onServerSessionState(callback: (update: ServerCoordinatorUpdate) => void): () => void;
      onTabletMode(callback: (status: TabletModeStatus) => void): () => void;
      onLocalWhisperStatus(callback: (status: LocalWhisperStatus) => void): () => void;
    };
  }
}

export {};
