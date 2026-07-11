import { mkdtemp, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { AuthenticationService } from '../../electron/server/AuthenticationService';
import { PairedDeviceStore } from '../../electron/server/PairedDeviceStore';
import { PairingService } from '../../electron/server/PairingService';
import { PrompterServer } from '../../electron/server/PrompterServer';
import { ProtocolValidator } from '../../electron/server/ProtocolValidator';
import { ServerSessionBridge } from '../../electron/server/ServerSessionBridge';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../../shared/protocol/protocol-version';

const storage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
const discovery = {
  starts: 0, stops: 0, pairing: false,
  async start(_name: string, metadata: { pairing: boolean }) { this.starts++; this.pairing = metadata.pairing; },
  async update(metadata: { pairing: boolean }) { this.pairing = metadata.pairing; },
  async stop() { this.stops++; },
  diagnostics() { return { advertising: this.starts > this.stops, serviceType: '_prompter._tcp.local.', lastError: null }; }
};

function client(url: string) {
  const socket = new WebSocket(url);
  const inbox: any[] = [];
  const waiters = new Map<string, Array<(message: any) => void>>();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.get(message.type)?.shift();
    if (waiter) waiter(message); else inbox.push(message);
  });
  const opened = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const receive = (type: string) => {
    const index = inbox.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise<any>((resolve) => waiters.set(type, [...(waiters.get(type) ?? []), resolve]));
  };
  return { socket, opened, receive };
}

function envelope(type: string, payload: Record<string, unknown>, sequence = 0, connectionId = 'client-connection') {
  return JSON.stringify({
    protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR, type, serverId: 'server-1',
    sessionId: 'desktop-session', connectionId, sequence, sentAtMs: Date.now(), payload
  });
}

async function createSpokenPcm16Fixture(root: string) {
  const wavPath = path.join(root, 'spoken-tablet-fixture.wav');
  const escaped = wavPath.replace(/'/g, "''");
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); ` +
    `$s.SetOutputToWaveFile('${escaped}', $f); $s.Speak('The studio light blinked once, then settled.'); $s.Dispose()`
  ]);
  const wav = await readFile(wavPath);
  const dataOffset = wav.indexOf(Buffer.from('data'));
  if (dataOffset < 0) throw new Error('Generated spoken fixture did not contain a WAV data chunk.');
  const pcm = wav.subarray(dataOffset + 8);
  const twoSeconds = Buffer.alloc(16000 * 2 * 2);
  pcm.copy(twoSeconds, 0, 0, Math.min(pcm.length, twoSeconds.length));
  return twoSeconds;
}

describe('Windows-only simulated tablet', () => {
  it('pairs, authenticates, receives state, sends PCM, reconnects, and rejects forgotten credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-server-e2e-'));
    const spokenPcm = await createSpokenPcm16Fixture(root);
    const devices = new PairedDeviceStore(path.join(root, 'devices.json'), storage);
    await devices.load();
    const pairing = new PairingService(devices, async () => ({ approved: true }));
    const session = new ServerSessionBridge();
    session.applyRendererSync({
      rendererRevision: 1, manuscriptText: 'The studio light blinked once, then settled.', manuscriptId: 'spoken-fixture',
      currentTokenIndex: 0, followState: 'following', displaySettings: DEFAULT_DISPLAY_SETTINGS,
      selectedProviderId: 'manual', transcriptSourceActive: false, sessionResetId: 0
    });
    const server = new PrompterServer({
      serverId: 'server-1', productVersion: 'test', computerName: 'Test-PC', port: 0,
      pairing, devices, discovery: discovery as never, session,
      protocolValidator: new ProtocolValidator(path.join(process.cwd(), 'shared', 'protocol', 'schemas')),
      enumerateAddresses: () => ['127.0.0.1'],
      whisperSettings: { pythonExecutablePath: 'python', modelName: 'base.en', device: 'cpu', computeType: 'int8', chunkDurationSeconds: 2 },
      transcribe: async (chunk) => {
        expect(chunk.wav.subarray(0, 4).toString()).toBe('RIFF');
        return { text: 'The studio light blinked once, then settled.' };
      }
    });
    expect(server.getStatus().enabled).toBe(false);
    const status = await server.enable();
    expect(discovery.starts).toBe(1);
    server.startPairing();
    expect(discovery.pairing).toBe(true);

    const first = client(`ws://127.0.0.1:${status.port}`);
    await first.opened;
    await first.receive('serverChallenge');
    const pairingState = pairing.getState();
    first.socket.send(envelope('pairRequest', {
      action: 'pairRequest', requestId: 'request-1', deviceId: 'tablet-1', deviceName: 'Galaxy Tab', model: 'SM-X200',
      pairingCode: pairingState.code, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    const credentialMessage = await first.receive('pairCredential');
    const credential = credentialMessage.payload.credential as string;
    first.socket.close();

    const second = client(`ws://127.0.0.1:${status.port}`);
    await second.opened;
    const challenge = await second.receive('serverChallenge');
    const nonce = 'tablet-nonce';
    second.socket.send(envelope('authenticate', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce: nonce, timestampMs: Date.now(),
      proof: AuthenticationService.createProof(credential, challenge.payload.nonce, nonce, 'server-1', 'tablet-1', PROTOCOL_MAJOR),
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    await second.receive('authenticated');
    const snapshot = await second.receive('sessionSnapshot');
    expect(snapshot.payload.manuscript.manuscriptId).toBe('spoken-fixture');

    second.socket.send(envelope('audioStreamStart', {
      action: 'start', streamId: 'stream-1', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le',
      sequenceStart: 0, captureTimestampMs: Date.now(), frameDurationMs: 200
    }, 1));
    await second.receive('controllerLease');
    for (let sequence = 0; sequence < 10; sequence++) {
      second.socket.send(envelope('audioFrameMetadata', {
        streamId: 'stream-1', sequence, captureTimestampMs: Date.now(), sampleRate: 16000, channels: 1,
        encoding: 'pcm-s16le', sampleCount: 3200
      }, sequence + 2));
      second.socket.send(spokenPcm.subarray(sequence * 6400, (sequence + 1) * 6400));
    }
    expect((await second.receive('transcriptEvent')).payload.text).toContain('studio light');
    expect((await second.receive('movementEvent')).payload).toEqual(expect.objectContaining({
      sessionRevision: expect.any(Number), manuscriptRevision: expect.any(Number), targetTokenIndex: expect.any(Number)
    }));
    second.socket.close();

    const reconnected = client(`ws://127.0.0.1:${status.port}`);
    await reconnected.opened;
    const reconnectChallenge = await reconnected.receive('serverChallenge');
    reconnected.socket.send(envelope('authenticate', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce: nonce, timestampMs: Date.now(),
      proof: AuthenticationService.createProof(credential, reconnectChallenge.payload.nonce, nonce, 'server-1', 'tablet-1', PROTOCOL_MAJOR),
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    await reconnected.receive('authenticated');
    expect((await reconnected.receive('sessionSnapshot')).payload.manuscript.manuscriptId).toBe('spoken-fixture');
    reconnected.socket.close();

    await server.forgetDevice('tablet-1');
    const third = client(`ws://127.0.0.1:${status.port}`);
    await third.opened;
    const newChallenge = await third.receive('serverChallenge');
    third.socket.send(envelope('authenticate', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce: nonce, timestampMs: Date.now(),
      proof: AuthenticationService.createProof(credential, newChallenge.payload.nonce, nonce, 'server-1', 'tablet-1', PROTOCOL_MAJOR),
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    expect((await third.receive('authenticationFailed')).payload.reason).toContain('Unknown');
    third.socket.close();
    await server.disable();
    expect(discovery.stops).toBeGreaterThan(0);
  }, 15_000);
});
