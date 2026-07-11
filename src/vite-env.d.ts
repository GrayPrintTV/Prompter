/// <reference types="vite/client" />

import type {
  ElectronBridgeDiagnostics,
  LiveAsrConfigStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTranscriptResult,
  MainPreloadError,
  OpenAiRealtimeSdpAnswer
} from './domain/types';
import type {
  RendererSessionSync,
  RendererSyncResult,
  ServerCoordinatorUpdate,
  ServerStatusSummary
} from '../shared/protocol/messages';

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
      toggleFullScreen(): Promise<boolean>;
      toggleAlwaysOnTop(): Promise<boolean>;
      getOpenAiRealtimeConfigStatus(): Promise<LiveAsrConfigStatus>;
      exchangeOpenAiRealtimeSdp(offerSdp: string): Promise<OpenAiRealtimeSdpAnswer>;
      getBridgeDiagnostics(): Promise<ElectronBridgeDiagnostics>;
      getLocalWhisperStatus(): Promise<LocalWhisperStatus>;
      startLocalWhisper(settings: LocalWhisperSettings): Promise<LocalWhisperStatus>;
      stopLocalWhisper(): Promise<LocalWhisperStatus>;
      transcribeLocalWhisperChunk(payload: {
        audioData: ArrayBuffer;
        mimeType: string;
        format: string;
        extension: string;
        sampleRate?: number;
        durationSeconds?: number;
        headerSignature?: string;
        settings: LocalWhisperSettings;
      }): Promise<LocalWhisperTranscriptResult>;
      syncServerSession(payload: RendererSessionSync): Promise<RendererSyncResult>;
      getServerStatus(): Promise<ServerStatusSummary | null>;
      getServerDiagnostics(): Promise<unknown>;
      onServerStatus(callback: (status: ServerStatusSummary) => void): () => void;
      onServerSessionState(callback: (update: ServerCoordinatorUpdate) => void): () => void;
      onLocalWhisperStatus(callback: (status: LocalWhisperStatus) => void): () => void;
    };
  }
}

export {};
