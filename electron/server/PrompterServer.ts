import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '#prompter-shared/protocol/protocol-version.js';
import type {
  AudioFrameMetadata,
  AudioStreamStartPayload,
  AuthenticatePayload,
  PairRequestPayload,
  ProtocolEnvelope,
  ServerStatusSummary
} from '#prompter-shared/protocol/messages.js';
import type { LocalWhisperSettings } from '#prompter-shared/domain/types.js';
import type { MovementDecisionInfo } from '#prompter-shared/domain/movementDiagnostics.js';
import type { SessionCoordinatorState } from '#prompter-shared/session/SessionCoordinator.js';
import { AudioIngress, type AudioChunk } from './AudioIngress.js';
import { AuthenticationService } from './AuthenticationService.js';
import type { DiscoveryService } from './DiscoveryService.js';
import type { PairedDeviceStore } from './PairedDeviceStore.js';
import type { PairingService } from './PairingService.js';
import type { ServerSessionBridge } from './ServerSessionBridge.js';
import type { ProtocolValidator } from './ProtocolValidator.js';

type Client = {
  socket: WebSocket;
  connectionId: string;
  remoteAddress: string;
  authenticated: boolean;
  deviceId: string | null;
  displayName: string | null;
  sequence: number;
  outgoingSequence: number;
  pendingAudioMetadata: AudioFrameMetadata | null;
  authenticationTimer: ReturnType<typeof setTimeout>;
  alive: boolean;
};

export type PrompterServerOptions = {
  serverId: string;
  productVersion: string;
  computerName: string;
  port?: number;
  pairing: PairingService;
  devices: PairedDeviceStore;
  discovery: DiscoveryService;
  session: ServerSessionBridge;
  transcribe(chunk: AudioChunk, settings: LocalWhisperSettings): Promise<{ text: string; durationSeconds?: number }>;
  whisperSettings: LocalWhisperSettings;
  enumerateAddresses?: () => string[];
  protocolValidator?: ProtocolValidator;
};

const CLEARTEXT_WARNING = 'Authenticated cleartext WebSocket is for a trusted-LAN prototype only; certificate-pinned WSS is required before broader distribution.';

export class PrompterServer {
  private listener: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, Client>();
  private bindAddress: string | null = null;
  private boundPort: number | null = null;
  private enabled = false;
  private state: ServerStatusSummary['state'] = 'off';
  private lastError: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private advertisedServiceName: string | null = null;
  private readonly auth: AuthenticationService;
  private readonly audio: AudioIngress;
  private readonly statusListeners = new Set<(status: ServerStatusSummary) => void>();
  private transcriptionQueue: AudioChunk[] = [];
  private transcriptionActive = false;
  private lastTranscript: string | null = null;
  private lastMovement: unknown = null;
  private authenticationFailures = 0;

  constructor(private readonly options: PrompterServerOptions) {
    this.auth = new AuthenticationService(options.serverId, options.devices);
    this.audio = new AudioIngress((chunk) => this.enqueueTranscription(chunk), (deviceId) => options.session.getControllerDeviceId() === deviceId);
    options.pairing.onState((pairing) => {
      if (this.enabled) {
        this.state = pairing.active ? 'pairing' : this.clients.size ? 'connected' : 'available';
        void options.discovery.update(this.discoveryMetadata()).catch((error) => this.recordError(error));
      }
      this.emitStatus();
    });
  }

  async enable() {
    if (this.enabled) return this.getStatus();
    this.state = 'starting';
    this.lastError = null;
    this.emitStatus();
    const candidates = this.addresses();
    if (!candidates.length) {
      this.state = 'error';
      this.lastError = 'No usable private IPv4 interface was found. Connect to a private LAN and try again.';
      this.emitStatus();
      throw new Error(this.lastError);
    }
    this.bindAddress = candidates[0];
    try {
      this.listener = await this.listen(this.bindAddress, this.options.port ?? 43127);
      const address = this.listener.address();
      this.boundPort = typeof address === 'object' && address ? address.port : (this.options.port ?? 43127);
      this.enabled = true;
      this.state = 'available';
      this.advertisedServiceName = `Prompter - ${this.options.computerName}`;
      await this.options.discovery.start(this.advertisedServiceName, this.discoveryMetadata());
      this.heartbeat = setInterval(() => this.pingClients(), 15_000);
      this.emitStatus();
      return this.getStatus();
    } catch (error) {
      await this.disable();
      this.state = 'error';
      const code = (error as NodeJS.ErrnoException).code;
      this.lastError = code === 'EADDRINUSE'
        ? `Port ${this.options.port ?? 43127} is already in use.`
        : `Server startup failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emitStatus();
      throw error;
    }
  }

  async disable() {
    this.options.pairing.stop();
    this.audio.stop();
    this.options.session.releaseController();
    for (const client of this.clients.values()) {
      this.send(client, 'serverShutdown', { reason: 'Server disabled.' });
      clearTimeout(client.authenticationTimer);
      client.socket.close(1001, 'Server disabled');
    }
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const listener = this.listener;
    this.listener = null;
    if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
    await this.options.discovery.stop();
    this.enabled = false;
    this.bindAddress = null;
    this.boundPort = null;
    this.advertisedServiceName = null;
    this.state = 'off';
    this.emitStatus();
  }

  async shutdown() {
    await this.disable();
  }

  startPairing() {
    if (!this.enabled) throw new Error('Enable the server before pairing a tablet.');
    return this.options.pairing.start();
  }

  stopPairing() {
    this.options.pairing.stop();
  }

  disconnectDevice(deviceId: string) {
    for (const client of this.clients.values()) {
      if (client.deviceId === deviceId) client.socket.close(4001, 'Disconnected by user');
    }
  }

  async forgetDevice(deviceId: string) {
    this.disconnectDevice(deviceId);
    return this.options.devices.forget(deviceId);
  }

  onStatus(listener: (status: ServerStatusSummary) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  broadcastSnapshot() {
    const snapshot = this.options.session.getSnapshot();
    if (!snapshot) return;
    for (const client of this.clients.values()) if (client.authenticated) this.send(client, 'sessionSnapshot', snapshot);
  }

  getStatus(): ServerStatusSummary {
    const pairing = this.options.pairing.getState();
    const storage = this.options.devices.diagnostics();
    return {
      enabled: this.enabled,
      state: this.state,
      bindAddress: this.bindAddress,
      port: this.boundPort ?? this.options.port ?? 43127,
      candidateAddresses: this.addresses(),
      advertisedServiceName: this.advertisedServiceName,
      pairingActive: pairing.active,
      pairingCode: pairing.code,
      pairingExpiresAtMs: pairing.expiresAt,
      pairedDeviceCount: storage.recordCount,
      pairedDevices: this.options.devices.list().map(({ deviceId, displayName, model, lastConnectedAt }) => ({
        deviceId, displayName, model, lastConnectedAt
      })),
      connectedDevices: [...this.clients.values()].filter((client) => client.authenticated).map((client) => ({
        deviceId: client.deviceId!, displayName: client.displayName ?? client.deviceId!, remoteAddress: client.remoteAddress
      })),
      controllerDeviceId: this.options.session.getControllerDeviceId(),
      transcriptAuthority: this.options.session.getAuthority(),
      safeStorageAvailable: storage.safeStorageAvailable,
      credentialStorage: storage.credentialStorage,
      cleartextTransportWarning: CLEARTEXT_WARNING,
      lastError: this.lastError
    };
  }

  diagnostics() {
    return {
      ...this.getStatus(),
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      discovery: this.options.discovery.diagnostics(),
      networkHints: {
        firewall: 'No firewall rule is created. If discovery works but connection fails, Windows Firewall may be blocking the selected port.',
        profile: 'Use only on a trusted Private Windows network profile; public-profile detection is not available without platform-specific privileges.'
      },
      audio: this.audio.diagnostics(),
      authenticationFailures: this.authenticationFailures,
      lastTranscript: this.lastTranscript,
      lastMovement: this.lastMovement,
      transcriptionQueueLength: this.transcriptionQueue.length
    };
  }

  private listen(host: string, port: number) {
    return new Promise<WebSocketServer>((resolve, reject) => {
      const listener = new WebSocketServer({ host, port });
      listener.once('listening', () => resolve(listener));
      listener.once('error', reject);
      listener.on('connection', (socket, request) => this.accept(socket, request.socket.remoteAddress ?? 'unknown'));
    });
  }

  private accept(socket: WebSocket, remoteAddress: string) {
    const connectionId = randomUUID();
    const client: Client = {
      socket, connectionId, remoteAddress, authenticated: false, deviceId: null, displayName: null,
      sequence: -1, outgoingSequence: 0, pendingAudioMetadata: null, alive: true,
      authenticationTimer: setTimeout(() => socket.close(4003, 'Authentication timeout'), 10_000)
    };
    this.clients.set(socket, client);
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (data, binary) => void this.handleMessage(client, data, binary));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));
    const challenge = this.auth.issue(connectionId);
    this.send(client, 'serverChallenge', { nonce: challenge.nonce, issuedAtMs: challenge.issuedAtMs, serverId: this.options.serverId });
  }

  private async handleMessage(client: Client, data: Parameters<WebSocket['send']>[0], binary: boolean) {
    try {
      if (binary) {
        if (!client.authenticated || !client.deviceId || !client.pendingAudioMetadata) throw new Error('Binary audio frame is missing authenticated metadata.');
        const metadata = client.pendingAudioMetadata;
        client.pendingAudioMetadata = null;
        await this.audio.accept(client.deviceId, metadata, Buffer.from(data as ArrayBuffer));
        return;
      }
      const message = JSON.parse(data.toString()) as { type?: string; action?: string; sequence?: number; payload?: unknown } & Record<string, unknown>;
      const payload = (message.payload && typeof message.payload === 'object' ? message.payload : message) as Record<string, unknown>;
      if (message.payload) this.options.protocolValidator?.assert('envelope', message);
      const action = String(message.type ?? message.action ?? payload.action ?? '');
      if (action === 'pairRequest') {
        this.options.protocolValidator?.assert('pairing', payload);
        const request = payload as unknown as PairRequestPayload;
        if (request.protocolMajor !== PROTOCOL_MAJOR) throw new Error('Protocol major mismatch.');
        const result = await this.options.pairing.request({ ...request, remoteAddress: client.remoteAddress }, request.pairingCode);
        this.send(client, result.approved ? 'pairCredential' : 'pairDenied', result);
        if (!result.approved) client.socket.close(4003, result.reason);
        return;
      }
      if (action === 'authenticate') {
        this.options.protocolValidator?.assert('pairing', payload);
        const result = await this.auth.verify(client.connectionId, payload as unknown as AuthenticatePayload, client.remoteAddress);
        if (!result.ok) {
          this.authenticationFailures++;
          this.send(client, 'authenticationFailed', { reason: result.reason });
          client.socket.close(4003, result.reason);
          return;
        }
        client.authenticated = true;
        client.deviceId = result.device.deviceId;
        client.displayName = result.device.displayName;
        clearTimeout(client.authenticationTimer);
        this.send(client, 'authenticated', { deviceId: client.deviceId });
        this.send(client, 'sessionSnapshot', this.options.session.getSnapshot());
        this.state = 'connected';
        this.emitStatus();
        return;
      }
      if (!client.authenticated || !client.deviceId) throw new Error('Client is not authenticated.');
      const sequence = Number(message.sequence ?? payload.sequence ?? -1);
      if (sequence <= client.sequence) return;
      if (client.sequence >= 0 && sequence > client.sequence + 1) this.send(client, 'sessionSnapshot', this.options.session.getSnapshot());
      client.sequence = sequence;
      if (action === 'requestSnapshot') this.send(client, 'sessionSnapshot', this.options.session.getSnapshot());
      else if (action === 'audioStreamStart') {
        this.options.protocolValidator?.assert('audio', payload);
        if (!this.options.session.acquireController(client.deviceId)) throw new Error('Desktop transcription or another tablet currently owns the transcript source.');
        this.audio.start(client.deviceId, payload as unknown as AudioStreamStartPayload);
        this.send(client, 'controllerLease', { granted: true, deviceId: client.deviceId });
        this.emitStatus();
      } else if (action === 'audioFrameMetadata') {
        this.options.protocolValidator?.assert('audioMetadata', payload);
        if (client.pendingAudioMetadata) throw new Error('Previous audio metadata has no binary frame.');
        client.pendingAudioMetadata = payload as unknown as AudioFrameMetadata;
      } else if (action === 'audioStreamStop') {
        this.audio.stop(client.deviceId);
        this.options.session.releaseController(client.deviceId);
        this.send(client, 'controllerLease', { granted: false, deviceId: client.deviceId });
        this.emitStatus();
      }
    } catch (error) {
      this.send(client, 'protocolError', { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private enqueueTranscription(chunk: AudioChunk) {
    if (this.transcriptionQueue.length >= 4) this.transcriptionQueue.shift();
    this.transcriptionQueue.push(chunk);
    void this.drainTranscriptionQueue();
  }

  private async drainTranscriptionQueue() {
    if (this.transcriptionActive) return;
    this.transcriptionActive = true;
    try {
      while (this.transcriptionQueue.length) {
        const chunk = this.transcriptionQueue.shift()!;
        if (this.options.session.getControllerDeviceId() !== chunk.deviceId) continue;
        const result = await this.options.transcribe(chunk, this.options.whisperSettings);
        if (!result.text.trim()) continue;
        const processed = this.options.session.processTabletTranscript(chunk.deviceId, result.text, chunk.lastSequence);
        this.lastTranscript = result.text;
        this.lastMovement = processed.movement;
        for (const client of this.clients.values()) if (client.authenticated) {
          this.send(client, 'transcriptEvent', processed.transcript);
          if (processed.movement) this.send(client, 'movementEvent', this.semanticMovement(processed.state, processed.movement));
          this.send(client, 'sessionSnapshot', this.options.session.getSnapshot());
        }
      }
    } catch (error) {
      this.recordError(error);
    } finally {
      this.transcriptionActive = false;
    }
  }

  private send(client: Client, type: string, payload: unknown) {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const state = this.options.session.getState();
    const envelope: ProtocolEnvelope<unknown> = {
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      type,
      serverId: this.options.serverId,
      sessionId: String(state?.sessionRevision ?? 0),
      connectionId: client.connectionId,
      sequence: client.outgoingSequence++,
      sentAtMs: Date.now(),
      payload
    };
    client.socket.send(JSON.stringify(envelope));
  }

  private semanticMovement(state: SessionCoordinatorState, movement: MovementDecisionInfo) {
    const snapshot = this.options.session.getSnapshot();
    const token = snapshot?.manuscript.tokens[state.currentTokenIndex];
    return {
      sessionRevision: state.sessionRevision,
      manuscriptRevision: state.manuscriptRevision,
      confirmedTokenIndex: movement.confirmedTokenIndex,
      targetTokenIndex: state.currentTokenIndex,
      targetCharacter: token?.characterRange.start ?? state.currentCharacter,
      sentenceIndex: state.currentSentenceIndex,
      paragraphIndex: state.currentParagraphIndex,
      confidence: movement.confidence,
      durationHintMs: Math.max(0, Math.round(Math.abs(movement.movementDeltaTokens) / (160 / 60) * 1000)),
      classification: movement.classification,
      reason: movement.reason
    };
  }

  private removeClient(client: Client) {
    if (!this.clients.delete(client.socket)) return;
    clearTimeout(client.authenticationTimer);
    this.auth.clear(client.connectionId);
    if (client.deviceId) {
      this.audio.stop(client.deviceId);
      this.options.session.releaseController(client.deviceId);
    }
    this.state = this.options.pairing.getState().active ? 'pairing' : this.clients.size ? 'connected' : this.enabled ? 'available' : 'off';
    this.emitStatus();
  }

  private pingClients() {
    for (const client of this.clients.values()) {
      if (!client.alive) { client.socket.terminate(); continue; }
      client.alive = false;
      client.socket.ping();
    }
  }

  private addresses() {
    return (this.options.enumerateAddresses ?? privateIpv4Addresses)();
  }

  private discoveryMetadata() {
    return {
      serverId: this.options.serverId, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR,
      productVersion: this.options.productVersion, pairing: this.options.pairing.getState().active,
      port: this.boundPort ?? this.options.port ?? 43127
    };
  }

  private recordError(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.emitStatus();
  }

  private emitStatus() {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }
}

export function privateIpv4Addresses() {
  const addresses = new Set<string>();
  for (const records of Object.values(networkInterfaces())) for (const record of records ?? []) {
    if (record.family !== 'IPv4' || record.internal) continue;
    const parts = record.address.split('.').map(Number);
    const privateAddress = parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
    if (privateAddress) addresses.add(record.address);
  }
  return [...addresses];
}
