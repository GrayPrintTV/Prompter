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

async function receiveWithin(connection: ReturnType<typeof client>, type: string, timeoutMs: number) {
  return Promise.race([
    connection.receive(type),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

async function createSpokenPcm16Fixture(root: string) {
  const wavPath = path.join(root, 'spoken-tablet-fixture.wav');
  const escaped = wavPath.replace(/'/g, "''");
  const twoSeconds = Buffer.alloc(16000 * 2 * 2);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); ` +
      `$s.SetOutputToWaveFile('${escaped}', $f); $s.Speak('The studio light blinked once, then settled.'); $s.Dispose()`
    ], { stdio: 'ignore' });
    const wav = await readFile(wavPath);
    const dataOffset = wav.indexOf(Buffer.from('data'));
    if (dataOffset < 0) throw new Error('Generated spoken fixture did not contain a WAV data chunk.');
    wav.subarray(dataOffset + 8).copy(twoSeconds, 0, 0, twoSeconds.length);
  } catch {
    // The server test stubs transcription and only needs deterministic non-empty PCM
    // to exercise audio framing on Windows hosts without an installed SAPI voice.
    for (let sample = 0; sample < 16000 * 2; sample++) {
      twoSeconds.writeInt16LE(Math.round(Math.sin(sample / 12) * 1200), sample * 2);
    }
  }
  return twoSeconds;
}

describe('Windows-only simulated tablet', () => {
  it('pairs, authenticates, receives state, sends PCM, reconnects, and rejects forgotten credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-server-e2e-'));
    const spokenPcm = await createSpokenPcm16Fixture(root);
    const devices = new PairedDeviceStore(path.join(root, 'devices.json'), storage);
    await devices.load();
    const observerCredential = 'observer-test-credential';
    await devices.save({
      deviceId: 'observer-tablet',
      displayName: 'Observer tablet',
      model: 'Test observer',
      credential: observerCredential,
      createdAt: Date.now(),
      lastConnectedAt: null,
      lastKnownAddress: null,
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR
    });
    const pairing = new PairingService(devices, async () => ({ approved: true }));
    const session = new ServerSessionBridge();
    const diagnosticEvents: Array<{ event: string }> = [];
    session.applyRendererSync({
      rendererRevision: 1, manuscriptText: 'The studio light blinked once, then settled.', manuscriptId: 'spoken-fixture',
      currentTokenIndex: 0, followState: 'following', displaySettings: DEFAULT_DISPLAY_SETTINGS,
      selectedProviderId: 'manual', transcriptSourceActive: false, sessionResetId: 0
    });
    const server = new PrompterServer({
      serverId: 'server-1', productVersion: 'test', computerName: 'Test-PC', port: 0,
      pairing, devices, discovery: discovery as never, session,
      protocolValidator: new ProtocolValidator(path.join(process.cwd(), 'shared', 'protocol', 'schemas')),
      diagnostics: { record(input) { diagnosticEvents.push({ event: input.event }); return {} as never; } },
      controllerDisconnectTimeoutMs: 50,
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

    const malformed = client(`ws://127.0.0.1:${status.port}/`);
    await malformed.opened;
    await malformed.receive('serverChallenge');
    const malformedClose = new Promise<{ code: number; reason: string }>((resolve) => malformed.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    malformed.socket.send('{not-json');
    expect(await malformedClose).toEqual(expect.objectContaining({ code: 1002 }));

    const unauthenticatedAudio = client(`ws://127.0.0.1:${status.port}/`);
    await unauthenticatedAudio.opened;
    await unauthenticatedAudio.receive('serverChallenge');
    const unauthenticatedAudioClose = new Promise<{ code: number; reason: string }>((resolve) =>
      unauthenticatedAudio.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    );
    unauthenticatedAudio.socket.send(Buffer.alloc(6400));
    expect(await unauthenticatedAudioClose).toEqual(expect.objectContaining({
      code: 1008,
      reason: 'Unauthenticated binary audio frame.'
    }));

    const mismatch = client(`ws://127.0.0.1:${status.port}/`);
    await mismatch.opened;
    await mismatch.receive('serverChallenge');
    const mismatchClose = new Promise<{ code: number; reason: string }>((resolve) => mismatch.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    mismatch.socket.send(envelope('pairRequest', {
      action: 'pairRequest', requestId: 'wire-mismatch', deviceId: 'android-wire', deviceName: 'Galaxy Tab A8',
      model: 'SM-X200', protocolMajor: 2, protocolMinor: 0
    }));
    expect(await mismatch.receive('protocolError')).toBeTruthy();
    expect(await mismatchClose).toEqual(expect.objectContaining({ code: 1008, reason: 'Protocol major mismatch.' }));

    server.startPairing();
    expect(discovery.pairing).toBe(true);

    const pairingState = pairing.getState();
    const wrongCode = pairingState.code === '000000' ? '999999' : '000000';
    const rejectedPair = client(`ws://127.0.0.1:${status.port}/`);
    await rejectedPair.opened;
    await rejectedPair.receive('serverChallenge');
    const rejectedClose = new Promise<{ code: number; reason: string }>((resolve) => rejectedPair.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    rejectedPair.socket.send(envelope('pairRequest', {
      action: 'pairRequest', requestId: 'bad-code', deviceId: 'android-wire', deviceName: 'Galaxy Tab A8',
      model: 'SM-X200', pairingCode: wrongCode, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    expect((await rejectedPair.receive('pairDenied')).payload.reason).toContain('code');
    expect((await rejectedClose).code).toBe(1008);

    const first = client(`ws://127.0.0.1:${status.port}`);
    await first.opened;
    await first.receive('serverChallenge');
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

    const observer = client(`ws://127.0.0.1:${status.port}`);
    await observer.opened;
    const observerChallenge = await observer.receive('serverChallenge');
    const observerNonce = 'observer-nonce';
    observer.socket.send(envelope('authenticate', {
      action: 'authenticate',
      deviceId: 'observer-tablet',
      clientNonce: observerNonce,
      timestampMs: Date.now(),
      proof: AuthenticationService.createProof(
        observerCredential,
        observerChallenge.payload.nonce,
        observerNonce,
        'server-1',
        'observer-tablet',
        PROTOCOL_MAJOR
      ),
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR
    }));
    await observer.receive('authenticated');
    await observer.receive('sessionSnapshot');
    observer.socket.send(Buffer.alloc(6400));
    observer.socket.send(envelope('requestSnapshot', { action: 'requestSnapshot' }, 1));
    expect((await observer.receive('sessionSnapshot')).payload.manuscript.manuscriptId).toBe('spoken-fixture');

    second.socket.send(envelope('manualFollowDiagnostic', {
      action: 'manualFollowDiagnostic',
      timestampMs: Date.now(),
      sequence: 17,
      level: 'info',
      event: 'android.manual_scroll.anchor_sent',
      message: 'Manual reposition anchor sent.',
      details: { anchorTokenIndex: '5' }
    }, 1));
    second.socket.send(envelope('audioStreamStart', {
      action: 'start', streamId: 'stream-1', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le',
      sequenceStart: 0, captureTimestampMs: Date.now(), frameDurationMs: 200
    }, 2));
    const lease = await second.receive('controllerLease');
    expect(lease.payload).toEqual(expect.objectContaining({
      granted: true,
      streamId: 'stream-1',
      streamRegistered: true,
      connectionGeneration: lease.connectionId
    }));
    observer.socket.send(envelope('audioStreamStart', {
      action: 'start', streamId: 'observer-stream', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le',
      sequenceStart: 0, captureTimestampMs: Date.now(), frameDurationMs: 200
    }, 2));
    expect((await observer.receive('controllerLease')).payload).toEqual(expect.objectContaining({
      granted: false,
      streamId: 'observer-stream',
      streamRegistered: false,
      connectionGeneration: expect.any(String),
      reason: expect.stringContaining('another tablet')
    }));
    observer.socket.send(envelope('requestSnapshot', { action: 'requestSnapshot' }, 3));
    expect((await observer.receive('sessionSnapshot')).payload.manuscript.manuscriptId).toBe('spoken-fixture');
    second.socket.send(Buffer.alloc(6400));
    second.socket.send(envelope('requestSnapshot', { action: 'requestSnapshot' }, 3));
    expect((await second.receive('sessionSnapshot')).payload.manuscript.manuscriptId).toBe('spoken-fixture');
    second.socket.send(envelope('audioStreamStart', {
      action: 'start', streamId: 'stream-1', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le',
      sequenceStart: 0, captureTimestampMs: Date.now(), frameDurationMs: 200
    }, 2));
    expect((await second.receive('controllerLease')).payload).toEqual(expect.objectContaining({
      granted: true,
      streamId: 'stream-1',
      streamRegistered: false,
      reason: expect.stringContaining('out of order')
    }));
    for (let sequence = 0; sequence < 10; sequence++) {
      second.socket.send(envelope('audioFrameMetadata', {
        streamId: 'stream-1', sequence, captureTimestampMs: Date.now(), sampleRate: 16000, channels: 1,
        encoding: 'pcm-s16le', sampleCount: 3200
      }, sequence + 4));
      second.socket.send(spokenPcm.subarray(sequence * 6400, (sequence + 1) * 6400));
    }
    const transcriptEvent = await second.receive('transcriptEvent');
    expect(transcriptEvent.payload.text).toContain('studio light');
    const movementEvent = await second.receive('movementEvent');
    expect(movementEvent.sessionId).toBe(snapshot.sessionId);
    expect(transcriptEvent.sessionId).toBe(snapshot.sessionId);
    expect(movementEvent.payload).toEqual(expect.objectContaining({
      sessionRevision: expect.any(Number), manuscriptRevision: expect.any(Number), targetTokenIndex: expect.any(Number)
    }));
    expect(await receiveWithin(observer, 'movementEvent', 200)).toBeNull();
    expect(diagnosticEvents.map((event) => event.event)).toEqual(expect.arrayContaining([
      'tablet.manual_follow.trace', 'coordinator.transcript.processed', 'coordinator.position.accepted',
      'coordinator.movement.produced', 'server.movement.sent'
    ]));
    const reconnected = client(`ws://127.0.0.1:${status.port}`);
    await reconnected.opened;
    const reconnectChallenge = await reconnected.receive('serverChallenge');
    reconnected.socket.send(envelope('authenticate', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce: nonce, timestampMs: Date.now(),
      proof: AuthenticationService.createProof(credential, reconnectChallenge.payload.nonce, nonce, 'server-1', 'tablet-1', PROTOCOL_MAJOR),
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }));
    await reconnected.receive('authenticated');
    expect((await reconnected.receive('controllerLease')).payload).toEqual(expect.objectContaining({
      granted: true,
      resumed: true,
      streamRegistered: false
    }));
    expect((await reconnected.receive('sessionSnapshot')).payload.manuscript.manuscriptId).toBe('spoken-fixture');
    reconnected.socket.send(envelope('audioStreamStart', {
      action: 'start', streamId: 'stream-1', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le',
      sequenceStart: 0, captureTimestampMs: Date.now(), frameDurationMs: 200
    }, 1));
    expect((await reconnected.receive('controllerLease')).payload)
      .toEqual(expect.objectContaining({
        granted: true,
        streamId: 'stream-1',
        streamRegistered: true,
        connectionGeneration: expect.any(String)
      }));

    const secondClosed = new Promise<void>((resolve) => second.socket.once('close', () => resolve()));
    observer.socket.close();
    second.socket.close();
    await secondClosed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.getStatus()).toEqual(expect.objectContaining({ operatingMode: 'tablet', controllerDeviceId: 'tablet-1' }));
    expect(diagnosticEvents.map((event) => event.event)).toContain('mode.tablet.replacement_connection_retained');
    reconnected.socket.close();

    await server.forgetDevice('tablet-1');
    expect(server.getStatus()).toEqual(expect.objectContaining({ operatingMode: 'desktop', controllerDeviceId: null }));
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
