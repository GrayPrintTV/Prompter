/// <reference types="vite/client" />

import type { LiveAsrConfigStatus, OpenAiRealtimeClientSession } from './domain/types';

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
    };
  }
}

export {};
