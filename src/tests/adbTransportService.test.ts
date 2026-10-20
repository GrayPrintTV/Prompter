import { describe, expect, it, vi } from 'vitest';
import {
  AdbTransportService,
  configuredAndroidSdkRoot,
  launchUsbArguments,
  parseAdbDevices,
  removeReverseArguments,
  reverseArguments,
  tabletRouteForAppId,
  VOCAL_USB_CONNECT_COMPONENT,
  USB_CONNECT_ACTION,
  USB_CONNECT_COMPONENT,
  USB_EXTRA_MODE,
  USB_EXTRA_PORT,
  USB_EXTRA_SERVER_ID
} from '../../electron/usb/AdbTransportService';

describe('ADB USB transport', () => {
  it('keeps the ordinary target and isolates the Vocal candidate target and reverse port', () => {
    const ordinary = tabletRouteForAppId('com.narrationprompter.prompter');
    const vocal = tabletRouteForAppId('com.narrationprompter.prompter.vocalcandidate');
    expect(ordinary).toEqual({ component: USB_CONNECT_COMPONENT, tabletLocalPort: 43128, desktopServerPort: 43127, noRebind: false });
    expect(vocal).toEqual({ component: VOCAL_USB_CONNECT_COMPONENT, tabletLocalPort: 43130, desktopServerPort: 43129, noRebind: true });
    expect(reverseArguments('A1', vocal.tabletLocalPort, vocal.desktopServerPort, vocal.noRebind)).toEqual([
      '-s', 'A1', 'reverse', '--no-rebind', 'tcp:43130', 'tcp:43129'
    ]);
    expect(launchUsbArguments('A1', 'server-1', vocal.tabletLocalPort, 'auto', vocal.component)).toContain(VOCAL_USB_CONNECT_COMPONENT);
  });

  it('uses the Vocal route throughout setup and cleanup without touching the ordinary tunnel', async () => {
    const commands: string[][] = [];
    const route = tabletRouteForAppId('com.narrationprompter.prompter.vocalcandidate');
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo', route, environment: { PROMPTER_ADB_PATH: 'adb.exe' }, exists: () => true,
      stabilityMs: 0, now: () => 10,
      run: async (_executable, args) => {
        commands.push(args);
        return { stdout: args[0] === 'devices' ? 'List of devices attached\nA1\tdevice model:SM_X200\n' : '', stderr: '' };
      },
      ensureServer: async () => ({ serverId: 'server-1', port: route.desktopServerPort })
    });
    await service.poll();
    await service.poll();
    expect(commands).toContainEqual(reverseArguments('A1', 43130, 43129, true));
    expect(commands).toContainEqual(launchUsbArguments('A1', 'server-1', 43130, 'auto', VOCAL_USB_CONNECT_COMPONENT));
    await service.stop();
    expect(commands).toContainEqual(removeReverseArguments('A1', 43130));
    expect(commands.some((args) => args.includes('tcp:43128'))).toBe(false);
  });
  it('constructs typed reverse, cleanup, and launch commands without shell interpolation', () => {
    expect(reverseArguments('R9 serial', 43128, 43127)).toEqual([
      '-s', 'R9 serial', 'reverse', 'tcp:43128', 'tcp:43127'
    ]);
    expect(removeReverseArguments('R9 serial', 43128)).toEqual([
      '-s', 'R9 serial', 'reverse', '--remove', 'tcp:43128'
    ]);
    expect(launchUsbArguments('R9', 'server/a', 43128, 'auto')).toEqual([
      '-s', 'R9', 'shell', 'am', 'start', '-W',
      '-n', USB_CONNECT_COMPONENT,
      '-a', USB_CONNECT_ACTION,
      '--es', USB_EXTRA_SERVER_ID, 'server/a',
      '--ei', USB_EXTRA_PORT, '43128',
      '--es', USB_EXTRA_MODE, 'auto'
    ]);
  });

  it('rejects hostile values before constructing the actual adb argv', () => {
    const hostile = `server & space ' " ; | $() < >`;
    expect(() => launchUsbArguments('R9', hostile, 43128, 'auto')).toThrow('identifier');
    expect(() => launchUsbArguments(`R9 & ' " ; | $()`, 'server', 43128, 'auto')).toThrow('serial');
    const argv = launchUsbArguments('R8YW91FL9DA', '14b40156-277a-4395-bcfa-06b37be3a4d9', 43128, 'usb-only');
    expect(argv.join(' ')).not.toMatch(/[&'";|$()<>]/);
    expect(argv).toEqual([
      '-s', 'R8YW91FL9DA', 'shell', 'am', 'start', '-W',
      '-n', 'app.prompter.tablet/.MainActivity',
      '-a', 'app.prompter.tablet.action.CONNECT_USB',
      '--es', 'usb_server_id', '14b40156-277a-4395-bcfa-06b37be3a4d9',
      '--ei', 'usb_port', '43128',
      '--es', 'usb_mode', 'usb-only'
    ]);
  });

  it('discovers the configured SDK and parses authorized, unauthorized, and offline devices', () => {
    expect(configuredAndroidSdkRoot('C:\\repo', { ANDROID_SDK_ROOT: 'C:\\Sdk' })).toBe('C:\\Sdk');
    expect(configuredAndroidSdkRoot('C:\\repo', {}, () => 'sdk.dir=C:\\\\Android\\\\Sdk')).toBe('C:\\Android\\Sdk');
    expect(parseAdbDevices([
      'List of devices attached',
      'A1\tdevice product:gta8 model:SM_X200 transport_id:1',
      'B2\tunauthorized usb:1-1',
      'C3\toffline transport_id:3',
      ''
    ].join('\r\n'))).toEqual([
      { serial: 'A1', rawState: 'device', state: 'authorized', model: 'SM_X200' },
      { serial: 'B2', rawState: 'unauthorized', state: 'unauthorized', model: null },
      { serial: 'C3', rawState: 'offline', state: 'offline', model: null }
    ]);
  });

  it.each([
    ['', 'no-device'],
    ['U1\tunauthorized usb:1', 'unauthorized'],
    ['A1\tdevice\nA2\tdevice', 'multiple-devices']
  ])('handles non-selectable device output without establishing a reverse tunnel', async (deviceLines, expectedState) => {
    const commands: string[][] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'C:\\Sdk\\adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      run: async (_executable, args) => {
        commands.push(args);
        return { stdout: args[0] === 'devices' ? `List of devices attached\n${deviceLines}\n` : '', stderr: '' };
      },
      ensureServer: vi.fn(async () => ({ serverId: 'server', port: 43127 }))
    });
    await service.poll();
    expect(service.getStatus().state).toBe(expectedState);
    expect(commands).toEqual([['devices', '-l']]);
  });

  it('requires cable stability, then establishes and removes one reverse rule', async () => {
    let now = 1_000;
    let attached = true;
    const commands: string[][] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'C:\\Sdk\\adb.exe' },
      exists: () => true,
      now: () => now,
      stabilityMs: 1_500,
      run: async (_executable, args) => {
        commands.push(args);
        return { stdout: args[0] === 'devices' ? `List of devices attached\n${attached ? 'A1\tdevice model:Tablet' : ''}\n` : '', stderr: '' };
      },
      ensureServer: vi.fn(async () => ({ serverId: 'server-1', port: 43127 }))
    });

    await service.poll();
    expect(service.getStatus().state).toBe('stabilizing');
    now += 1_499;
    await service.poll();
    expect(commands.filter((args) => args.includes('reverse'))).toHaveLength(0);
    now += 1;
    await service.poll();
    expect(service.getStatus().state).toBe('awaiting-tablet');
    expect(commands).toContainEqual(reverseArguments('A1', 43128, 43127));
    expect(commands.some((args) => args.includes(USB_CONNECT_ACTION))).toBe(true);

    attached = false;
    await service.poll();
    expect(commands).toContainEqual(removeReverseArguments('A1', 43128));
    expect(service.getStatus().state).toBe('no-device');
  });

  it('never guesses among multiple devices and allows explicit Advanced selection', async () => {
    let now = 1_000;
    const commands: string[][] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'C:\\Sdk\\adb.exe' },
      exists: () => true,
      now: () => now,
      stabilityMs: 0,
      run: async (_executable, args) => {
        commands.push(args);
        return { stdout: args[0] === 'devices' ? 'List of devices attached\nA1\tdevice\nA2\tdevice\n' : '', stderr: '' };
      },
      ensureServer: vi.fn(async () => ({ serverId: 'server', port: 43127 }))
    });
    await service.poll();
    expect(service.getStatus().state).toBe('multiple-devices');
    service.selectDevice('A2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += 1;
    await service.poll();
    expect(commands).toContainEqual(reverseArguments('A2', 43128, 43127));
  });

  it('surfaces missing ADB and reverse failures without requesting the server', async () => {
    const ensureServer = vi.fn(async () => ({ serverId: 'server', port: 43127 }));
    const missing = new AdbTransportService({
      rootDirectory: 'C:\\repo', environment: {}, exists: () => false, ensureServer
    });
    await missing.poll();
    expect(missing.getStatus()).toMatchObject({ state: 'adb-missing', lastError: null });
    expect(ensureServer).not.toHaveBeenCalled();

    let now = 1_000;
    const failing = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      now: () => now,
      ensureServer,
      run: async (_executable, args) => {
        if (args[0] === 'devices') return { stdout: 'List of devices attached\nA1\tdevice\n', stderr: '' };
        throw new Error('reverse denied');
      }
    });
    await failing.poll();
    now += 1;
    await failing.poll();
    expect(failing.getStatus()).toMatchObject({ state: 'error', lastError: 'reverse denied' });
  });

  it('reports tablet authentication timeout and recognizes a loopback connection', async () => {
    let now = 1_000;
    let attached = true;
    const commands: string[][] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      now: () => now,
      ensureServer: async () => ({ serverId: 'server', port: 43127 }),
      run: async (_executable, args) => {
        commands.push(args);
        return {
          stdout: args[0] === 'devices' ? `List of devices attached\n${attached ? 'A1\tdevice' : ''}\n` : '',
          stderr: ''
        };
      }
    });
    await service.poll();
    now += 1;
    await service.poll();
    now += 15_001;
    await service.poll();
    expect(service.getStatus()).toMatchObject({
      state: 'error',
      lastError: 'Tablet USB connection timed out.'
    });
    expect(commands).toContainEqual(removeReverseArguments('A1', 43128));

    attached = false;
    await service.poll();
    attached = true;
    await service.poll();
    now += 1;
    await service.poll();
    service.observeConnectedDevices([{ remoteAddress: '::ffff:127.0.0.1' }]);
    expect(service.getStatus().state).toBe('connected');
    service.observeConnectedDevices([{ remoteAddress: '192.168.1.5' }]);
    expect(service.getStatus().state).toBe('awaiting-tablet');
  });

  it('retains a working tunnel during multiple-device selection without status oscillation', async () => {
    let now = 1_000;
    let deviceLines = 'A1\tdevice';
    const statuses: string[] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      now: () => now,
      ensureServer: async () => ({ serverId: 'server', port: 43127 }),
      onStatus: (status) => statuses.push(status.state),
      run: async (_executable, args) => ({
        stdout: args[0] === 'devices' ? `List of devices attached\n${deviceLines}\n` : '',
        stderr: ''
      })
    });
    await service.poll();
    now += 1;
    await service.poll();
    service.observeConnectedDevices([{ remoteAddress: '127.0.0.1' }]);
    deviceLines = 'A1\tdevice\nA2\tdevice';
    await service.poll();
    expect(service.getStatus().state).toBe('multiple-devices');
    const statusCount = statuses.length;
    service.observeConnectedDevices([{ remoteAddress: '127.0.0.1' }]);
    expect(service.getStatus().state).toBe('multiple-devices');
    expect(statuses).toHaveLength(statusCount);
  });

  it('gives an authenticated LAN handoff a bounded grace period before reverse cleanup', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const commands: string[][] = [];
      const service = new AdbTransportService({
        rootDirectory: 'C:\\repo',
        environment: { PROMPTER_ADB_PATH: 'adb.exe' },
        exists: () => true,
        stabilityMs: 0,
        handoffGraceMs: 500,
        now: () => now,
        ensureServer: async () => ({ serverId: 'server', port: 43127 }),
        run: async (_executable, args) => {
          commands.push(args);
          return { stdout: args[0] === 'devices' ? 'List of devices attached\nA1\tdevice\n' : '', stderr: '' };
        }
      });
      await service.poll();
      now += 1;
      await service.poll();
      service.setMode('lan-only');
      await vi.runAllTicks();
      expect(commands).not.toContainEqual(removeReverseArguments('A1', 43128));
      await vi.advanceTimersByTimeAsync(500);
      expect(commands).toContainEqual(removeReverseArguments('A1', 43128));
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off failed Activity launches, exhausts attempts, and retries only after a meaningful reset', async () => {
    let now = 1_000;
    const commands: string[][] = [];
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      retryBaseMs: 100,
      retryMaxDelayMs: 200,
      retryMaxAttempts: 3,
      retryCooldownMs: 1_000,
      now: () => now,
      ensureServer: async () => ({ serverId: 'server', port: 43127 }),
      run: async (_executable, args) => {
        commands.push(args);
        if (args[0] === 'devices') return { stdout: 'List of devices attached\nA1\tdevice\n', stderr: '' };
        if (args.includes(USB_CONNECT_ACTION)) throw new Error('Activity launch rejected');
        return { stdout: '', stderr: '' };
      }
    });
    const launchCount = () => commands.filter((args) => args.includes(USB_CONNECT_ACTION)).length;
    await service.poll();
    now += 1;
    await service.poll();
    expect(launchCount()).toBe(1);
    await service.poll();
    expect(launchCount()).toBe(1);
    now += 100;
    await service.poll();
    expect(launchCount()).toBe(2);
    now += 200;
    await service.poll();
    expect(launchCount()).toBe(3);
    now += 5_000;
    await service.poll();
    expect(launchCount()).toBe(3);
    expect(service.getStatus().message).toContain('paused');

    service.retryNow();
    await Promise.resolve();
    now += 1;
    await service.poll();
    expect(launchCount()).toBe(4);
  });

  it('fences reverse setup when shutdown overtakes an in-flight server start', async () => {
    let releaseServer!: (value: { serverId: string; port: number }) => void;
    const server = new Promise<{ serverId: string; port: number }>((resolve) => { releaseServer = resolve; });
    const commands: string[][] = [];
    let now = 1_000;
    const service = new AdbTransportService({
      rootDirectory: 'C:\\repo',
      environment: { PROMPTER_ADB_PATH: 'adb.exe' },
      exists: () => true,
      stabilityMs: 0,
      now: () => now,
      ensureServer: () => server,
      run: async (_executable, args) => {
        commands.push(args);
        return { stdout: args[0] === 'devices' ? 'List of devices attached\nA1\tdevice\n' : '', stderr: '' };
      }
    });
    await service.poll();
    now += 1;
    const configuring = service.poll();
    await Promise.resolve();
    const stopping = service.stop();
    releaseServer({ serverId: 'server', port: 43127 });
    await Promise.all([configuring, stopping]);
    expect(commands).not.toContainEqual(reverseArguments('A1', 43128, 43127));
  });
});
