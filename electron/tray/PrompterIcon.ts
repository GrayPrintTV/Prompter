import { app, nativeImage } from 'electron';
import path from 'node:path';

// Original high-contrast P/screen mark. The generated PNG is used at runtime so Windows gets a
// consistently visible tray/taskbar image; SVG remains the safe last-resort fallback.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="3" y="3" width="58" height="58" rx="12" fill="#101820" stroke="#FFFFFF" stroke-width="4"/><path d="M19 48V16h16c8 0 13 5 13 12s-5 12-13 12h-8v8zM27 24v8h7c4 0 6-1 6-4s-2-4-6-4z" fill="#FFFFFF"/><path d="M45 13h6v6h-6z" fill="#80CBC4"/></svg>`;

export function resolvePrompterIconPath(options: { appPath?: string; resourcesPath?: string; packaged?: boolean } = {}) {
  const packaged = options.packaged ?? app.isPackaged;
  const root = packaged ? (options.resourcesPath ?? process.resourcesPath) : (options.appPath ?? app.getAppPath());
  return path.join(root, 'assets', 'icons', 'prompter-256.png');
}

export function createPrompterIcon(options: { appPath?: string; resourcesPath?: string; packaged?: boolean; warn?: (message: string) => void } = {}) {
  const warn = options.warn ?? console.warn;
  const iconPath = resolvePrompterIconPath(options);
  const fromFile = nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) return fromFile;
  warn(`[Prompter] icon.load.failed path=${iconPath}; using embedded visible fallback.`);
  const fallback = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`);
  if (fallback.isEmpty()) warn('[Prompter] icon.rasterization.failed; Electron fallback icon will be used.');
  return fallback;
}
