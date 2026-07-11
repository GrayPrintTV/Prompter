import { describe, expect, it, vi } from 'vitest';
import type { ServerStatusSummary } from '../../shared/protocol/messages';

const mocks = vi.hoisted(() => ({ templates: [] as any[][], tooltip: '', destroyed: false }));
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ setTemplateImage: vi.fn() }) },
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
    transcriptAuthority: 'manual', safeStorageAvailable: true, credentialStorage: 'encrypted',
    cleartextTransportWarning: 'prototype', lastError: null, ...overrides
  };
}

describe('TrayController', () => {
  it('builds server, pairing, device, diagnostics, and explicit quit commands', async () => {
    const actions = {
      openPrompter: vi.fn(), toggleServer: vi.fn(), pairTablet: vi.fn(), disconnectDevice: vi.fn(),
      forgetDevice: vi.fn(), showDiagnostics: vi.fn(), quit: vi.fn()
    };
    const tray = new TrayController(actions);
    tray.create(status({
      enabled: true, state: 'pairing', bindAddress: '192.168.1.2', pairingActive: true, pairingCode: '123456',
      pairedDeviceCount: 1, pairedDevices: [{ deviceId: 'tablet', displayName: 'Galaxy Tab', model: 'SM-X200', lastConnectedAt: 1 }],
      connectedDevices: [{ deviceId: 'tablet', displayName: 'Galaxy Tab', remoteAddress: '192.168.1.8' }]
    }));
    const template = mocks.templates.at(-1)!;
    expect(template.map((item) => item.label).filter(Boolean)).toEqual(expect.arrayContaining([
      'Open Prompter', 'Server Off', 'Pair Tablet', 'Pairing code: 123456', 'Connected Devices',
      'Paired Devices', 'Copy Server Address', 'Diagnostics', 'Quit'
    ]));
    template.find((item) => item.label === 'Server Off').click();
    template.find((item) => item.label === 'Diagnostics').click();
    template.find((item) => item.label === 'Quit').click();
    expect(actions.toggleServer).toHaveBeenCalledOnce();
    expect(actions.showDiagnostics).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
    tray.destroy();
    expect(mocks.destroyed).toBe(true);
  });
});
