/// <reference types="vite/client" />

import type {
  ElectronBridgeDiagnostics,
  LiveAsrConfigStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTranscriptResult,
  MainPreloadError,
  OpenAiRealtimeClientSession
} from './domain/types';

type ImportedTextFile = {
  filePath: string;
  name: string;
  text: string;
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
      openTextFile(): Promise<ImportedTextFile | null>;
      toggleFullScreen(): Promise<boolean>;
      toggleAlwaysOnTop(): Promise<boolean>;
      getOpenAiRealtimeConfigStatus(): Promise<LiveAsrConfigStatus>;
      createOpenAiRealtimeClientSession(): Promise<OpenAiRealtimeClientSession>;
      getBridgeDiagnostics(): Promise<ElectronBridgeDiagnostics>;
      getLocalWhisperStatus(): Promise<LocalWhisperStatus>;
      startLocalWhisper(settings: LocalWhisperSettings): Promise<LocalWhisperStatus>;
      stopLocalWhisper(): Promise<LocalWhisperStatus>;
      transcribeLocalWhisperChunk(payload: {
        audioData: ArrayBuffer;
        mimeType: string;
        settings: LocalWhisperSettings;
      }): Promise<LocalWhisperTranscriptResult>;
      onLocalWhisperStatus(callback: (status: LocalWhisperStatus) => void): () => void;
    };
  }
}

export {};
