import { Menu, Tray, clipboard, nativeImage } from 'electron';
import type { ServerStatusSummary } from '#prompter-shared/protocol/messages.js';

export type TrayActions = {
  openPrompter(): void;
  toggleServer(): Promise<void> | void;
  pairTablet(): void;
  disconnectDevice(deviceId: string): void;
  forgetDevice(deviceId: string): Promise<void> | void;
  showDiagnostics(): void;
  quit(): Promise<void> | void;
};

// Temporary neutral 16x16 PNG. State remains accessible in tooltip and menu text until polished assets arrive.
const PLACEHOLDER_ICON = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR42mNgGAWjYBSMglEwCkbBKBgF4z8DA8P/DAwM/xkYGP4zMDD8Z2Bg+M/AwPAfA0PDAwA9jQYhCgT2ywAAAABJRU5ErkJggg==';

export class TrayController {
  private tray: Tray | null = null;
  private status: ServerStatusSummary | null = null;

  constructor(private readonly actions: TrayActions) {}

  create(initialStatus: ServerStatusSummary) {
    if (this.tray) return;
    const icon = nativeImage.createFromBuffer(Buffer.from(PLACEHOLDER_ICON, 'base64'));
    icon.setTemplateImage(true);
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
      { label: 'Open Prompter', click: () => this.actions.openPrompter() },
      { type: 'separator' },
      { label: status.enabled ? 'Server Off' : 'Server On', click: () => void this.actions.toggleServer() },
      { label: 'Pair Tablet', enabled: status.enabled && !status.pairingActive, click: () => this.actions.pairTablet() },
      ...(status.pairingActive ? [{ label: `Pairing code: ${status.pairingCode ?? 'pending'}`, enabled: false } as const] : []),
      { label: 'Connected Devices', submenu: devices },
      { label: 'Paired Devices', submenu: pairedDevices },
      { label: 'Copy Server Address', enabled: Boolean(address), click: () => address && clipboard.writeText(address) },
      { label: 'Diagnostics', click: () => this.actions.showDiagnostics() },
      { type: 'separator' },
      { label: 'Quit', click: () => void this.actions.quit() }
    ]));
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
    this.status = null;
  }
}
