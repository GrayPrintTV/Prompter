import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  UsbDeviceSummary,
  UsbTransportMode,
  UsbTransportStatus
} from '#prompter-shared/protocol/messages.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_USB_TABLET_PORT = 43128;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_STABILITY_MS = 1_500;
const DEFAULT_HANDOFF_GRACE_MS = 12_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_COOLDOWN_MS = 60_000;
export const USB_CONNECT_ACTION = 'app.prompter.tablet.action.CONNECT_USB';
export const USB_CONNECT_COMPONENT = 'app.prompter.tablet/.MainActivity';
export const USB_EXTRA_SERVER_ID = 'usb_server_id';
export const USB_EXTRA_PORT = 'usb_port';
export const USB_EXTRA_MODE = 'usb_mode';

export type AdbCommandResult = { stdout: string; stderr: string };
export type AdbRunner = (executable: string, args: string[]) => Promise<AdbCommandResult>;

export type AdbTransportDependencies = {
  rootDirectory: string;
  environment?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  readText?: (candidate: string) => string;
  run?: AdbRunner;
  now?: () => number;
  ensureServer(): Promise<{ serverId: string; port: number }>;
  onStatus?(status: UsbTransportStatus): void;
  pollIntervalMs?: number;
  stabilityMs?: number;
  tabletLocalPort?: number;
  handoffGraceMs?: number;
  handshakeTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxDelayMs?: number;
  retryMaxAttempts?: number;
  retryCooldownMs?: number;
};

type ParsedAdbDevice = UsbDeviceSummary & { rawState: string };

function unquote(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function configuredAndroidSdkRoot(rootDirectory: string, environment: NodeJS.ProcessEnv, readText = (candidate: string) => readFileSync(candidate, 'utf8')) {
  const configured = environment.ANDROID_SDK_ROOT || environment.ANDROID_HOME;
  if (configured) return unquote(configured);
  const propertiesPath = path.join(rootDirectory, 'android', 'local.properties');
  try {
    const match = readText(propertiesPath).match(/^sdk\.dir\s*=\s*(.+)$/m);
    if (match) return unquote(match[1].replace(/\\\\/g, '\\'));
  } catch {
    // An unconfigured checkout is normal; fall through to the conventional SDK path.
  }
  const localAppData = environment.LOCALAPPDATA;
  return localAppData ? path.join(localAppData, 'Android', 'Sdk') : null;
}

export function adbExecutableCandidates(rootDirectory: string, environment: NodeJS.ProcessEnv = process.env) {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];
  if (environment.PROMPTER_ADB_PATH) candidates.push(unquote(environment.PROMPTER_ADB_PATH));
  const sdkRoot = configuredAndroidSdkRoot(rootDirectory, environment);
  if (sdkRoot) candidates.push(path.join(sdkRoot, 'platform-tools', executable));
  for (const entry of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(unquote(entry), executable));
  }
  return [...new Set(candidates)];
}

export function resolveAdbExecutable(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = (candidate) => existsSync(candidate)
) {
  return adbExecutableCandidates(rootDirectory, environment).find((candidate) => exists(candidate)) ?? null;
}

export function parseAdbDevices(output: string): ParsedAdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices'))
    .map((line) => {
      const [serial = '', rawState = 'unknown', ...details] = line.split(/\s+/);
      const model = details.find((item) => item.startsWith('model:'))?.slice('model:'.length) ?? null;
      const state: UsbDeviceSummary['state'] = rawState === 'device'
        ? 'authorized'
        : rawState === 'unauthorized'
          ? 'unauthorized'
          : rawState === 'offline'
            ? 'offline'
            : 'unknown';
      return { serial, rawState, state, model };
    })
    .filter((device) => Boolean(device.serial));
}

export function reverseArguments(serial: string, tabletLocalPort: number, desktopServerPort: number) {
  return ['-s', serial, 'reverse', `tcp:${tabletLocalPort}`, `tcp:${desktopServerPort}`];
}

export function removeReverseArguments(serial: string, tabletLocalPort: number) {
  return ['-s', serial, 'reverse', '--remove', `tcp:${tabletLocalPort}`];
}

export function launchUsbArguments(serial: string, serverId: string, tabletLocalPort: number, mode: UsbTransportMode = 'auto') {
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(serverId)) throw new Error('USB server identifier is invalid.');
  if (!Number.isInteger(tabletLocalPort) || tabletLocalPort < 1 || tabletLocalPort > 65_535) throw new Error('USB endpoint port is invalid.');
  if (!['auto', 'lan-only', 'usb-only'].includes(mode)) throw new Error('USB transport mode is invalid.');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(serial)) throw new Error('ADB device serial is invalid.');
  return [
    '-s', serial, 'shell', 'am', 'start', '-W',
    '-n', USB_CONNECT_COMPONENT,
    '-a', USB_CONNECT_ACTION,
    '--es', USB_EXTRA_SERVER_ID, serverId,
    '--ei', USB_EXTRA_PORT, String(tabletLocalPort),
    '--es', USB_EXTRA_MODE, mode
  ];
}

export class AdbTransportService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly exists: (candidate: string) => boolean;
  private readonly run: AdbRunner;
  private readonly now: () => number;
  private readonly tabletLocalPort: number;
  private readonly stabilityMs: number;
  private adbPath: string | null = null;
  private mode: UsbTransportMode = 'auto';
  private selectedSerial: string | null = null;
  private candidateSerial: string | null = null;
  private candidateSinceMs = 0;
  private tunnel: { serial: string; desktopPort: number; serverId: string; configuredAtMs: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retirementTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private lifecycleGeneration = 0;
  private loopbackConnected = false;
  private topologyKey = '';
  private retryAttempts = 0;
  private retryNotBeforeMs = 0;
  private retryExhausted = false;
  private status: UsbTransportStatus;

  constructor(private readonly deps: AdbTransportDependencies) {
    this.environment = deps.environment ?? process.env;
    this.exists = deps.exists ?? existsSync;
    this.run = deps.run ?? (async (executable, args) => {
      const result = await execFileAsync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    });
    this.now = deps.now ?? (() => Date.now());
    this.tabletLocalPort = deps.tabletLocalPort ?? DEFAULT_USB_TABLET_PORT;
    this.stabilityMs = deps.stabilityMs ?? DEFAULT_STABILITY_MS;
    this.status = this.makeStatus('idle', 'USB tablet discovery has not started.');
  }

  getStatus() {
    return { ...this.status, devices: this.status.devices.map((device) => ({ ...device })) };
  }

  start() {
    if (this.timer) return;
    this.lifecycleGeneration += 1;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  async stop() {
    this.lifecycleGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.retirementTimer) clearTimeout(this.retirementTimer);
    this.timer = null;
    this.retirementTimer = null;
    await this.removeTunnel();
  }

  setMode(mode: UsbTransportMode) {
    this.lifecycleGeneration += 1;
    this.mode = mode;
    this.resetRetry();
    if (this.retirementTimer) clearTimeout(this.retirementTimer);
    this.retirementTimer = null;
    if (mode === 'lan-only') {
      this.candidateSerial = null;
      void this.disableUsbTunnel();
    } else {
      if (this.tunnel) void this.relaunchCurrentTunnel();
      else void this.poll();
    }
  }

  selectDevice(serial: string | null) {
    this.lifecycleGeneration += 1;
    this.selectedSerial = serial;
    this.resetRetry();
    this.candidateSerial = null;
    void this.poll();
  }

  retryNow() {
    this.resetRetry();
    this.candidateSerial = null;
    void this.poll();
  }

  observeConnectedDevices(devices: Array<{ remoteAddress: string }>) {
    if (!this.tunnel) return;
    const loopbackConnected = devices.some((device) => /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(device.remoteAddress));
    this.loopbackConnected = loopbackConnected;
    if (loopbackConnected && ['awaiting-tablet', 'setting-up', 'stabilizing', 'error'].includes(this.status.state)) {
      this.resetRetry();
      this.publish(this.makeStatus('connected', `Tablet authenticated through USB (${this.tunnel.serial}).`, this.status.devices, this.tunnel.desktopPort));
    } else if (!loopbackConnected && this.status.state === 'connected') {
      this.resetRetry();
      this.publish(this.makeStatus('awaiting-tablet', `USB connection was lost; waiting for tablet reconnect or automatic LAN fallback.`, this.status.devices, this.tunnel.desktopPort));
      void this.relaunchCurrentTunnel();
    }
  }

  async poll() {
    if (this.polling || this.mode === 'lan-only') return;
    const lifecycleGeneration = this.lifecycleGeneration;
    this.polling = true;
    try {
      this.adbPath = resolveAdbExecutable(this.deps.rootDirectory, this.environment, this.exists);
      if (!this.adbPath) {
        this.publish(this.makeStatus('adb-missing', 'ADB was not found. LAN remains available; configure ANDROID_SDK_ROOT or PROMPTER_ADB_PATH.'));
        return;
      }
      let devices: ParsedAdbDevice[];
      try {
        devices = parseAdbDevices((await this.run(this.adbPath, ['devices', '-l'])).stdout);
        if (lifecycleGeneration !== this.lifecycleGeneration) return;
      } catch (error) {
        if (lifecycleGeneration !== this.lifecycleGeneration) return;
        this.publish(this.makeStatus('error', 'ADB device discovery failed; LAN remains available.', [], null, this.errorMessage(error)));
        return;
      }
      const summaries = devices.map(({ serial, state, model }) => ({ serial, state, model }));
      const topologyKey = summaries.map((device) => `${device.serial}:${device.state}`).sort().join('|');
      if (this.topologyKey && topologyKey !== this.topologyKey) this.resetRetry();
      this.topologyKey = topologyKey;
      const authorized = devices.filter((device) => device.state === 'authorized');
      if (authorized.length === 0) {
        this.candidateSerial = null;
        const unauthorized = devices.some((device) => device.state === 'unauthorized');
        this.publish(this.makeStatus(
          unauthorized ? 'unauthorized' : 'no-device',
          unauthorized ? 'USB debugging authorization is pending on the tablet; LAN remains available.' : 'No authorized USB tablet is attached; LAN remains available.',
          summaries
        ));
        if (this.tunnel && !devices.some((device) => device.serial === this.tunnel?.serial && device.state === 'authorized')) {
          await this.removeTunnel();
        }
        return;
      }
      let chosen: ParsedAdbDevice | undefined;
      if (authorized.length === 1) chosen = authorized[0];
      else if (this.selectedSerial) chosen = authorized.find((device) => device.serial === this.selectedSerial);
      if (!chosen) {
        this.candidateSerial = null;
        this.publish(this.makeStatus('multiple-devices', 'Multiple authorized tablets are attached. Select one in Advanced diagnostics; the current transport is retained.', summaries));
        return;
      }
      if (this.retryExhausted || this.now() < this.retryNotBeforeMs) {
        return;
      }
      if (this.tunnel?.serial === chosen.serial) {
        if (this.loopbackConnected) {
          this.publish(this.makeStatus('connected', `Tablet authenticated through USB (${this.tunnel.serial}).`, summaries, this.tunnel.desktopPort));
        } else if (this.now() - this.tunnel.configuredAtMs > (this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)) {
          const port = this.tunnel.desktopPort;
          await this.removeTunnel();
          this.recordAttemptFailure('USB reverse tunnel was active, but the tablet did not authenticate.', summaries, port, 'Tablet USB connection timed out.');
        } else {
          this.publish(this.makeStatus('awaiting-tablet', `USB tunnel is ready for ${chosen.model ?? chosen.serial}; waiting for tablet authentication.`, summaries, this.tunnel.desktopPort));
        }
        return;
      }
      if (this.candidateSerial !== chosen.serial) {
        this.candidateSerial = chosen.serial;
        this.candidateSinceMs = this.now();
        this.publish(this.makeStatus('stabilizing', `Authorized tablet ${chosen.model ?? chosen.serial} detected; waiting briefly for a stable cable.`, summaries));
        return;
      }
      if (this.now() - this.candidateSinceMs < this.stabilityMs) {
        this.publish(this.makeStatus('stabilizing', `Authorized tablet ${chosen.model ?? chosen.serial} detected; waiting briefly for a stable cable.`, summaries));
        return;
      }
      await this.configure(chosen, summaries, lifecycleGeneration);
    } finally {
      this.polling = false;
    }
  }

  private async configure(device: ParsedAdbDevice, devices: UsbDeviceSummary[], lifecycleGeneration: number) {
    this.publish(this.makeStatus('setting-up', `Establishing USB transport for ${device.model ?? device.serial}.`, devices));
    let server: { serverId: string; port: number };
    try {
      server = await this.deps.ensureServer();
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      if (this.tunnel) await this.removeTunnel();
      await this.run(this.adbPath!, reverseArguments(device.serial, this.tabletLocalPort, server.port));
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        try {
          await this.run(this.adbPath!, removeReverseArguments(device.serial, this.tabletLocalPort));
        } catch {
          // Device removal during shutdown is already an effective reverse cleanup.
        }
        return;
      }
    } catch (error) {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      this.recordAttemptFailure('ADB reverse-port setup failed.', devices, null, this.errorMessage(error));
      return;
    }
    this.tunnel = { serial: device.serial, desktopPort: server.port, serverId: server.serverId, configuredAtMs: this.now() };
    this.loopbackConnected = false;
    try {
      await this.run(this.adbPath!, launchUsbArguments(device.serial, server.serverId, this.tabletLocalPort, this.mode));
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
    } catch (error) {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      await this.removeTunnel();
      this.recordAttemptFailure('USB tunnel was created, but the tablet could not be instructed to connect.', devices, server.port, this.errorMessage(error));
      return;
    }
    this.publish(this.makeStatus('awaiting-tablet', `USB tunnel is ready for ${device.model ?? device.serial}; waiting for tablet authentication.`, devices, server.port));
  }

  private async removeTunnel() {
    const tunnel = this.tunnel;
    this.tunnel = null;
    this.loopbackConnected = false;
    if (!tunnel || !this.adbPath) return;
    try {
      await this.run(this.adbPath, removeReverseArguments(tunnel.serial, this.tabletLocalPort));
    } catch {
      // The cable/device may already be gone. ADB removes per-device reverse rules on disconnect.
    }
  }

  private async relaunchCurrentTunnel() {
    const lifecycleGeneration = this.lifecycleGeneration;
    const tunnel = this.tunnel;
    if (!tunnel || !this.adbPath) return;
    try {
      await this.run(this.adbPath, launchUsbArguments(
        tunnel.serial,
        tunnel.serverId,
        this.tabletLocalPort,
        this.mode
      ));
      if (lifecycleGeneration !== this.lifecycleGeneration || this.tunnel !== tunnel) return;
      tunnel.configuredAtMs = this.now();
      this.publish(this.makeStatus('awaiting-tablet', `USB preference updated; waiting for tablet authentication.`, this.status.devices, tunnel.desktopPort));
    } catch (error) {
      if (lifecycleGeneration !== this.lifecycleGeneration || this.tunnel !== tunnel) return;
      this.publish(this.makeStatus('error', 'The USB preference could not be sent to the tablet. LAN remains available.', this.status.devices, tunnel.desktopPort, this.errorMessage(error)));
    }
  }

  private async disableUsbTunnel() {
    const lifecycleGeneration = this.lifecycleGeneration;
    const tunnel = this.tunnel;
    if (tunnel && this.adbPath) {
      try {
        await this.run(this.adbPath, launchUsbArguments(
          tunnel.serial,
          tunnel.serverId,
          this.tabletLocalPort,
          'lan-only'
        ));
      } catch {
        // Removing the reverse rule still makes the USB path unavailable; Android's socket failure remains truthful.
      }
    }
    if (lifecycleGeneration !== this.lifecycleGeneration) return;
    this.publish(this.makeStatus('lan-only', 'USB transport is disabled in Advanced diagnostics; LAN remains available.'));
    if (!tunnel) return;
    this.retirementTimer = setTimeout(() => {
      this.retirementTimer = null;
      if (this.mode === 'lan-only' && this.tunnel === tunnel) void this.removeTunnel();
    }, this.deps.handoffGraceMs ?? DEFAULT_HANDOFF_GRACE_MS);
  }

  private makeStatus(
    state: UsbTransportStatus['state'],
    message: string,
    devices: UsbDeviceSummary[] = this.status?.devices ?? [],
    desktopServerPort: number | null = this.tunnel?.desktopPort ?? null,
    lastError: string | null = null
  ): UsbTransportStatus {
    return {
      mode: this.mode,
      state,
      adbPath: this.adbPath,
      devices,
      selectedSerial: this.selectedSerial,
      tabletLocalPort: this.tabletLocalPort,
      desktopServerPort,
      message,
      lastError
    };
  }

  private publish(status: UsbTransportStatus) {
    if (JSON.stringify(this.status) === JSON.stringify(status)) return;
    this.status = status;
    this.deps.onStatus?.(this.getStatus());
  }

  private resetRetry() {
    this.retryAttempts = 0;
    this.retryNotBeforeMs = 0;
    this.retryExhausted = false;
  }

  private recordAttemptFailure(message: string, devices: UsbDeviceSummary[], port: number | null, error: string) {
    this.retryAttempts += 1;
    if (this.retryAttempts >= (this.deps.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS)) {
      this.retryExhausted = true;
      this.retryNotBeforeMs = this.now() + (this.deps.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS);
      this.publish(this.makeStatus('error', `${message} Automatic retry paused after ${this.retryAttempts} attempts; LAN remains available.`, devices, port, error));
      return;
    }
    const delayMs = Math.min(
      (this.deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * (2 ** (this.retryAttempts - 1)),
      this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
    );
    this.retryNotBeforeMs = this.now() + delayMs;
    this.publish(this.makeStatus('error', `${message} Retry ${this.retryAttempts + 1} of ${this.deps.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS} in ${Math.ceil(delayMs / 1_000)} seconds; LAN remains available.`, devices, port, error));
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
