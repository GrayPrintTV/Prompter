import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairedDeviceStore } from '../../electron/server/PairedDeviceStore';
import { PairingService } from '../../electron/server/PairingService';
import { PrompterServer } from '../../electron/server/PrompterServer';
import { ServerSessionBridge } from '../../electron/server/ServerSessionBridge';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../../shared/protocol/protocol-version';

const storage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => ''
};

describe('tablet server build diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts server build identity in the challenge and prints the stable manual-follow prefix', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-build-diagnostics-'));
    const devices = new PairedDeviceStore(path.join(root, 'devices.json'), storage);
    await devices.load();
    const pairing = new PairingService(devices, async () => ({ approved: false }));
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const server = new PrompterServer({
      serverId: 'server-build-test',
      productVersion: '0.1.0',
      computerName: 'Test-PC',
      buildInfo: {
        versionName: '0.1.0',
        buildTimestamp: '2026-07-28T12:00:00.000Z',
        gitHash: 'abc123',
        dirty: true,
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR
      },
      port: 0,
      pairing,
      devices,
      discovery: {
        async start() {},
        async update() {},
        async stop() {},
        diagnostics() { return {}; }
      } as never,
      session: new ServerSessionBridge(),
      transcribe: async () => ({ text: '' }),
      whisperSettings: {
        pythonExecutablePath: 'python',
        modelName: 'base.en',
        device: 'cpu',
        computeType: 'int8',
        chunkDurationSeconds: 2
      },
      enumerateAddresses: () => ['127.0.0.1']
    });

    const status = await server.enable();
    const socket = new WebSocket(`ws://127.0.0.1:${status.port}`);
    const challenge = await new Promise<any>((resolve, reject) => {
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      socket.once('error', reject);
    });

    expect(challenge.payload).toEqual(expect.objectContaining({
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      serverStartedAtMs: expect.any(Number),
      serverBuild: expect.objectContaining({
        versionName: '0.1.0',
        buildTimestamp: '2026-07-28T12:00:00.000Z',
        gitHash: 'abc123',
        dirty: true
      })
    }));
    expect(consoleInfo).toHaveBeenCalledWith(
      '[TabletManualFollow]',
      'Server starting.',
      expect.stringContaining('"protocol"')
    );

    socket.close();
    await server.disable();
  });
});
