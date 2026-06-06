/// <reference types="vite/client" />

type ImportedTextFile = {
  filePath: string;
  name: string;
  text: string;
};

interface Window {
  prompterApi?: {
    openTextFile(): Promise<ImportedTextFile | null>;
    toggleFullScreen(): Promise<boolean>;
    toggleAlwaysOnTop(): Promise<boolean>;
  };
}
