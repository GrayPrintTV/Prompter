import type { TabletModeStatus } from '#prompter-shared/protocol/messages.js';

export type TabletModeHooks = {
  hideMainWindow(): void;
  notifyRenderer(status: TabletModeStatus): void;
  record(event: 'mode.tablet.entered' | 'mode.tablet.exited', status: TabletModeStatus): void;
};

export class TabletModeController {
  private status: TabletModeStatus = { mode: 'desktop', deviceId: null, deviceName: null, reason: 'No tablet controller lease' };

  constructor(private readonly hooks: TabletModeHooks) {}

  setController(deviceId: string | null, deviceName: string | null, reason: string) {
    if (deviceId) {
      if (this.status.mode === 'tablet' && this.status.deviceId === deviceId && this.status.deviceName === deviceName) return this.getStatus();
      this.status = { mode: 'tablet', deviceId, deviceName: deviceName ?? deviceId, reason };
      this.hooks.notifyRenderer(this.getStatus());
      this.hooks.hideMainWindow();
      this.hooks.record('mode.tablet.entered', this.getStatus());
    } else {
      if (this.status.mode === 'desktop') return this.getStatus();
      this.status = { mode: 'desktop', deviceId: null, deviceName: null, reason };
      this.hooks.notifyRenderer(this.getStatus());
      this.hooks.record('mode.tablet.exited', this.getStatus());
    }
    return this.getStatus();
  }

  getStatus(): TabletModeStatus { return { ...this.status }; }
  shouldHideOnWindowClose(quitting: boolean) { return !quitting && this.status.mode === 'tablet'; }
}
