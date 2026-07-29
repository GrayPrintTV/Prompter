import { describe, expect, it, vi } from 'vitest';
import type { ServerStatusSummary } from '../../shared/protocol/messages';

const mocks = vi.hoisted(() => ({ templates: [] as any[][], tooltip: '', destroyed: false }));
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  app: { getAppPath: () => 'C:/Prompter' },
  nativeImage: {
    createFromBuffer: () => ({ setTemplateImage: vi.fn() }),
    createFromPath: () => ({ isEmpty: () => false }),
    createFromDataURL: () => ({ isEmpty: () => false })
  },
  Menu: { buildFromTemplate: (template: any[]) => { mocks.templates.push(template); return template; } },
  Tray: class {
    constructor(_icon: unknown) {}
    on() {}
    setToolTip(value: string) { mocks.tooltip = value; }
    setContextMenu() {}
    destroy() { mocks.destroyed = true; }
  }
}));

import { TrayController } from '../../electron/tray/TrayController';

function status(overrides: Partial<ServerStatusSummary> = {}): ServerStatusSummary {
  return {
    enabled: false, state: 'off', bindAddress: null, port: 43127, candidateAddresses: ['192.168.1.2'],
    advertisedServiceName: null, pairingActive: false, pairingCode: null, pairingExpiresAtMs: null,
    pairedDeviceCount: 0, pairedDevices: [], connectedDevices: [], controllerDeviceId: null,
    controllerDisplayName: null, operatingMode: 'desktop', manuscriptLoaded: false,
    tabletNarrationActive: false, tabletStartDescription: 'Tablet will start at manuscript beginning', tabletResumeAvailable: false,
    transcriptAuthority: 'manual', safeStorageAvailable: true, credentialStorage: 'encrypted',
    cleartextTransportWarning: 'prototype', lastError: null, ...overrides
  };
}

describe('TrayController', () => {
  it('builds server, pairing, device, diagnostics, and explicit quit commands', async () => {
    const actions = {
      openPrompter: vi.fn(), hidePrompter: vi.fn(), toggleServer: vi.fn(), pairTablet: vi.fn(), disconnectDevice: vi.fn(), releaseTabletControl: vi.fn(), startTabletFromBeginning: vi.fn(), resumeTabletFromCurrentPosition: vi.fn(), setTabletPositionFromWindowsView: vi.fn(),
      forgetDevice: vi.fn(), showDiagnostics: vi.fn(), showLiveLog: vi.fn(), quit: vi.fn()
    };
    const tray = new TrayController(actions);
    tray.create(status({
      enabled: true, state: 'pairing', bindAddress: '192.168.1.2', pairingActive: true, pairingCode: '123456',
      pairedDeviceCount: 1, pairedDevices: [{ deviceId: 'tablet', displayName: 'Galaxy Tab', model: 'SM-X200', lastConnectedAt: 1 }],
      connectedDevices: [{ deviceId: 'tablet', displayName: 'Galaxy Tab', remoteAddress: '192.168.1.8' }],
      controllerDeviceId: 'tablet', controllerDisplayName: 'Galaxy Tab', operatingMode: 'tablet', manuscriptLoaded: true,
      tabletStartDescription: 'Tablet will resume near character 836', tabletResumeAvailable: true
    }));
    const template = mocks.templates.at(-1)!;
    expect(template.map((item) => item.label).filter(Boolean)).toEqual(expect.arrayContaining([
      'Mode: Tablet ? Galaxy Tab', 'Manuscript: Loaded', 'Open Prompter', 'Hide Prompter', 'Server Off', 'Pair Tablet', 'Pairing code: 123456', 'Connected Devices', 'Controller Device',
      'Paired Devices', 'Copy Server Address', 'Diagnostics', 'Live Tablet Log', 'Quit'
    ]));
    template.find((item) => item.label === 'Server Off').click();
    template.find((item) => item.label === 'Diagnostics').click();
    template.find((item) => item.label === 'Live Tablet Log').click();
    template.find((item) => item.label === 'Quit').click();
    expect(actions.toggleServer).toHaveBeenCalledOnce();
    expect(actions.showDiagnostics).toHaveBeenCalledOnce();
    expect(actions.showLiveLog).toHaveBeenCalledOnce();
    const controller = template.find((item) => item.label === 'Controller Device');
    controller.submenu[1].click();
    expect(actions.releaseTabletControl).toHaveBeenCalledOnce();
    template.find((item) => item.label === 'Start from Beginning').click();
    template.find((item) => item.label === 'Resume from Current Position').click();
    template.find((item) => item.label === 'Set Tablet Position from Windows View').click();
    expect(actions.startTabletFromBeginning).toHaveBeenCalledOnce();
    expect(actions.resumeTabletFromCurrentPosition).toHaveBeenCalledOnce();
    expect(actions.setTabletPositionFromWindowsView).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
    tray.destroy();
    expect(mocks.destroyed).toBe(true);
  });
});
