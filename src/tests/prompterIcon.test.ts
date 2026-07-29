import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const native = vi.hoisted(() => ({ fromPathEmpty: false, warnings: [] as string[] }));
vi.mock('electron', () => ({
  app: { getAppPath: () => 'C:/Prompter', isPackaged: false },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => native.fromPathEmpty }),
    createFromDataURL: () => ({ isEmpty: () => false })
  }
}));

import { createPrompterIcon, resolvePrompterIconPath } from '../../electron/tray/PrompterIcon';

describe('Prompter application icon', () => {
  it('resolves the packaged runtime PNG path and creates a non-empty icon', () => {
    expect(resolvePrompterIconPath({ appPath: 'C:/Prompter' })).toMatch(/assets[\\/]icons[\\/]prompter-256\.png$/);
    expect(resolvePrompterIconPath({ packaged: true, resourcesPath: 'C:/Prompter/resources' })).toContain('C:');
    expect(existsSync('assets/icons/prompter.ico')).toBe(true);
    expect(createPrompterIcon({ appPath: 'C:/Prompter' }).isEmpty()).toBe(false);
  });

  it('reports a missing raster resource and uses the visible SVG fallback', () => {
    native.fromPathEmpty = true;
    const warnings: string[] = [];
    expect(createPrompterIcon({ appPath: 'missing', warn: (message) => warnings.push(message) }).isEmpty()).toBe(false);
    expect(warnings.join(' ')).toContain('icon.load.failed');
    native.fromPathEmpty = false;
  });

  it('references the generated multi-resolution ico from electron-builder', () => {
    const config = readFileSync('electron-builder.yml', 'utf8');
    expect(config).toContain('icon: assets/icons/prompter.ico');
    expect(config).toContain('installerIcon: assets/icons/prompter.ico');
    expect(config).toContain('from: assets/icons');
  });
});
