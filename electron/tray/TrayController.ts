import { Menu, Tray, clipboard } from 'electron';
import { createPrompterIcon } from './PrompterIcon.js';
import type { ServerStatusSummary } from '#prompter-shared/protocol/messages.js';

export type TrayActions = {
  openPrompter(): void;
  hidePrompter(): void;
  toggleServer(): Promise<void> | void;
  pairTablet(): void;
  disconnectDevice(deviceId: string): void;
  releaseTabletControl(): void;
  startTabletFromBeginning(): void;
  resumeTabletFromCurrentPosition(): void;
  setTabletPositionFromWindowsView(): void;
  forgetDevice(deviceId: string): Promise<void> | void;
  showDiagnostics(): void;
  showLiveLog(): void;
  quit(): Promise<void> | void;
};

export class TrayController {
  private tray: Tray | null = null;
  private status: ServerStatusSummary | null = null;
  private windowVisible = true;

  constructor(private readonly actions: TrayActions) {}

  create(initialStatus: ServerStatusSummary) {
    if (this.tray) return;
    const icon = createPrompterIcon();
    this.tray = new Tray(icon);
    this.tray.on('double-click', () => this.actions.openPrompter());
    this.update(initialStatus);
  }

  update(status: ServerStatusSummary) {
    this.status = status;
    if (!this.tray) return;
    this.tray.setToolTip(`Prompter tablet server: ${status.state}`);
    const devices = status.connectedDevices.length
      ? status.connectedDevices.flatMap((device) => [
          { label: `${device.displayName} (${device.remoteAddress})`, enabled: false },
          { label: `Disconnect ${device.displayName}`, click: () => this.actions.disconnectDevice(device.deviceId) },
          { label: `Forget ${device.displayName}`, click: () => void this.actions.forgetDevice(device.deviceId) }
        ])
      : [{ label: 'No connected devices', enabled: false }];
    const pairedDevices = status.pairedDevices.length
      ? status.pairedDevices.map((device) => ({
          label: `Forget ${device.displayName} (${device.model})`,
          click: () => void this.actions.forgetDevice(device.deviceId)
        }))
      : [{ label: 'No paired devices', enabled: false }];
    const address = status.bindAddress ? `ws://${status.bindAddress}:${status.port}` : null;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: status.operatingMode === 'tablet' ? `Mode: Tablet ? ${status.controllerDisplayName ?? 'Tablet'}` : 'Mode: Desktop', enabled: false },
      { label: status.manuscriptLoaded ? 'Manuscript: Loaded' : 'Manuscript: Not loaded', enabled: false },
      { type: 'separator' },
      { label: 'Open Prompter', click: () => this.actions.openPrompter() },
      ...(this.windowVisible ? [{ label: 'Hide Prompter', click: () => this.actions.hidePrompter() } as const] : []),
      { type: 'separator' },
      { label: status.enabled ? 'Server Off' : 'Server On', click: () => void this.actions.toggleServer() },
      { label: 'Pair Tablet', enabled: status.enabled && !status.pairingActive, click: () => this.actions.pairTablet() },
      ...(status.pairingActive ? [{ label: `Pairing code: ${status.pairingCode ?? 'pending'}`, enabled: false } as const] : []),
      { label: 'Connected Devices', submenu: devices },
      { label: 'Controller Device', submenu: status.controllerDeviceId ? [
        { label: status.controllerDisplayName ?? status.controllerDeviceId, enabled: false },
        { label: 'Release Tablet Control', click: () => this.actions.releaseTabletControl() }
      ] : [{ label: 'No controller', enabled: false }] },
      ...(status.operatingMode === 'tablet' ? [
        { label: status.tabletStartDescription, enabled: false } as const,
        { label: 'Start from Beginning', enabled: !status.tabletNarrationActive, click: () => this.actions.startTabletFromBeginning() } as const,
        { label: 'Resume from Current Position', enabled: !status.tabletNarrationActive && status.tabletResumeAvailable, click: () => this.actions.resumeTabletFromCurrentPosition() } as const,
        { label: 'Set Tablet Position from Windows View', enabled: !status.tabletNarrationActive, click: () => this.actions.setTabletPositionFromWindowsView() } as const
      ] : []),
      { label: 'Paired Devices', submenu: pairedDevices },
      { label: 'Copy Server Address', enabled: Boolean(address), click: () => address && clipboard.writeText(address) },
      { label: 'Live Tablet Log', click: () => this.actions.showLiveLog() },
      { label: 'Diagnostics', click: () => this.actions.showDiagnostics() },
      { type: 'separator' },
      { label: 'Quit', click: () => void this.actions.quit() }
    ]));
  }

  setWindowVisible(visible: boolean) {
    this.windowVisible = visible;
    if (this.status) this.update(this.status);
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
    this.status = null;
  }
}
