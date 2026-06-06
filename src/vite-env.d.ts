/// <reference types="vite/client" />

import type {
  LiveAsrConfigStatus,
  LocalWhisperSettings,
  LocalWhisperStatus,
  LocalWhisperTranscriptResult,
  OpenAiRealtimeClientSession
} from './domain/types';

type ImportedTextFile = {
  filePath: string;
  name: string;
  text: string;
};

declare global {
  interface Window {
    prompterApi?: {
      openTextFile(): Promise<ImportedTextFile | null>;
      toggleFullScreen(): Promise<boolean>;
      toggleAlwaysOnTop(): Promise<boolean>;
      getOpenAiRealtimeConfigStatus(): Promise<LiveAsrConfigStatus>;
      createOpenAiRealtimeClientSession(): Promise<OpenAiRealtimeClientSession>;
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
