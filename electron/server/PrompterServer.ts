import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '#prompter-shared/protocol/protocol-version.js';
import type {
  AudioFrameMetadata,
  AudioStreamStartPayload,
  AuthenticatePayload,
  BuildIdentityPayload,
  PairRequestPayload,
  ProtocolEnvelope,
  ServerStatusSummary,
  TabletManualRepositionPayload,
  TabletManualRepositionStatus,
  TabletManualFollowDiagnosticPayload
} from '#prompter-shared/protocol/messages.js';
import type { LocalWhisperSettings } from '#prompter-shared/domain/types.js';
import type { MovementDecisionInfo } from '#prompter-shared/domain/movementDiagnostics.js';
import type { SessionCoordinatorState } from '#prompter-shared/session/SessionCoordinator.js';
import { AudioIngress, type AudioChunk } from './AudioIngress.js';
import { AuthenticationService } from './AuthenticationService.js';
import type { DiscoveryService } from './DiscoveryService.js';
import type { PairedDeviceStore } from './PairedDeviceStore.js';
import type { PairingService } from './PairingService.js';
import type {
  ServerSessionBridge,
  TabletNarrationStartPolicy
} from './ServerSessionBridge.js';
import type { ProtocolValidator } from './ProtocolValidator.js';
import type { DiagnosticSink } from './DiagnosticLogService.js';
import { diagnosticError } from './DiagnosticLogService.js';
import {
  compactSessionState,
  tabletSnapshotMessages,
  TABLET_MESSAGE_MAX_BYTES,
  TABLET_MESSAGE_WARN_BYTES,
  type TabletSnapshot
} from './TabletSnapshotTransport.js';
import type { IncomingMessage } from 'node:http';

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
  audioStreamId: string | null;
  authenticationTimer: ReturnType<typeof setTimeout>;
  alive: boolean;
  firstFrameSeen: boolean;
  audioFramesReceived: number;
  knownManuscriptHash: string | null;
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
  diagnostics?: DiagnosticSink;
  controllerDisconnectTimeoutMs?: number;
  buildInfo?: BuildIdentityPayload;
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
  private controllerDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly serverStartedAtMs = Date.now();

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
    options.session.onRuntimeSettings((settings) => {
      this.log({ component: 'server.settings', level: 'info', event: 'runtime-settings.sent', message: 'Windows runtime settings updated for authenticated tablets.', details: { settingsRevision: settings.settingsRevision } });
      for (const client of this.clients.values()) if (client.authenticated) this.send(client, 'runtimeSettings', settings);
    });
  }

  async enable() {
    if (this.enabled) return this.getStatus();
    this.state = 'starting';
    this.lastError = null;
    this.emitStatus();
    this.manualFollowLog('Server starting.', {
      serverStartedAtMs: this.serverStartedAtMs,
      productVersion: this.options.productVersion,
      buildInfo: this.options.buildInfo ?? null,
      protocol: `${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}`
    });
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
      this.log({ component: 'server.listener', level: 'info', event: 'server.listener.started', message: 'Tablet WebSocket listener started.', localAddress: `${this.bindAddress}:${this.boundPort}` });
      this.state = 'available';
      this.advertisedServiceName = `Prompter - ${this.options.computerName}`;
      await this.options.discovery.start(this.advertisedServiceName, this.discoveryMetadata());
      this.heartbeat = setInterval(() => this.pingClients(), 15_000);
      this.emitStatus();
      return this.getStatus();
    } catch (error) {
      this.log({ component: 'server.listener', level: 'error', event: 'server.listener.failed', message: 'Tablet listener failed to start.', ...diagnosticError(error) });
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
    this.clearControllerDisconnectTimer();
    this.options.session.endTabletNarration('Server disabled');
    this.options.session.releaseController();
    for (const client of this.clients.values()) {
      this.send(client, 'serverShutdown', { reason: 'Server disabled.' });
      clearTimeout(client.authenticationTimer);
      this.closeClient(client, 1001, 'Server disabled');
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
    if (this.options.session.getControllerDeviceId() === deviceId) this.releaseTabletControl(deviceId, 'Device disconnected from tray');
    for (const client of this.clients.values()) {
      if (client.deviceId === deviceId) this.closeClient(client, 1008, 'Disconnected by user');
    }
  }

  releaseTabletControl(deviceId?: string, reason = 'Tablet control released') {
    this.clearControllerDisconnectTimer();
    const controller = this.options.session.getControllerDeviceId();
    if (!controller || (deviceId && controller !== deviceId)) return false;
    this.audio.stop(controller);
    const narration = this.options.session.endTabletNarration(reason);
    const released = this.options.session.releaseController(controller);
    if (released) {
      for (const client of this.clients.values()) if (client.authenticated) {
        this.send(client, 'controllerLease', { granted: false, deviceId: controller, reason });
        this.sendSnapshot(client);
      }
      this.log({ component: 'server.mode', level: 'info', event: 'mode.tablet.control_released', message: reason, deviceId: controller, details: { narrationSessionEnded: Boolean(narration) } });
      this.emitStatus();
    }
    return released;
  }

  async forgetDevice(deviceId: string) {
    this.disconnectDevice(deviceId);
    return this.options.devices.forget(deviceId);
  }

  selectTabletStartPolicy(policy: TabletNarrationStartPolicy) {
    const status = this.options.session.selectTabletStartPolicy(policy);
    this.log({ component: 'server.session', level: 'info', event: 'session.position.initialized', message: status.startDescription, details: { policy, acceptedCharacter: status.acceptedCharacter, resumeAvailable: status.resumeAvailable } });
    this.emitStatus();
    return status;
  }

  selectTabletPositionFromWindowsView() {
    const status = this.options.session.selectTabletPositionFromWindowsView();
    this.log({ component: 'server.session', level: 'info', event: 'session.position.initialized', message: status.startDescription, details: { policy: 'windows-view', acceptedCharacter: status.acceptedCharacter } });
    this.emitStatus();
    return status;
  }

  onStatus(listener: (status: ServerStatusSummary) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  broadcastSnapshot() {
    const snapshot = this.options.session.getSnapshot();
    if (!snapshot) return;
    for (const client of this.clients.values()) if (client.authenticated) this.sendSnapshot(client, snapshot as TabletSnapshot);
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
      controllerDisplayName: this.controllerDisplayName(),
      operatingMode: this.options.session.getControllerDeviceId() ? 'tablet' : 'desktop',
      manuscriptLoaded: Boolean(this.options.session.getSnapshot()?.manuscript.normalizedContent?.trim()),
      tabletNarrationActive: this.options.session.getTabletNarrationStatus().active,
      tabletStartDescription: this.options.session.getTabletNarrationStatus().startDescription,
      tabletResumeAvailable: this.options.session.getTabletNarrationStatus().resumeAvailable,
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
      const listener = new WebSocketServer({ host, port, maxPayload: TABLET_MESSAGE_MAX_BYTES });
      listener.once('listening', () => resolve(listener));
      listener.once('error', reject);
      listener.on('connection', (socket, request) => this.accept(socket, request));
      listener.on('headers', (_headers, request) => this.log({
        component: 'server.websocket', level: 'debug', event: 'server.websocket.upgrade.accepted', message: 'WebSocket upgrade response accepted.',
        remoteAddress: request.socket.remoteAddress, details: { path: request.url ?? '/', host: request.headers.host, upgrade: request.headers.upgrade }
      }));
      listener.on('wsClientError', (error, socket, request) => this.log({
        component: 'server.websocket', level: 'warn', event: 'server.websocket.upgrade.rejected', message: 'WebSocket upgrade was rejected before open.',
        remoteAddress: request.socket.remoteAddress, ...diagnosticError(error), details: { path: request.url ?? '/', host: request.headers.host }
      }));
    });
  }

  private accept(socket: WebSocket, request: IncomingMessage) {
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    const connectionId = randomUUID();
    this.log({ component: 'server.network', level: 'info', event: 'server.tcp.connection', message: 'TCP/WebSocket peer accepted.', connectionId, remoteAddress, localAddress: `${request.socket.localAddress}:${request.socket.localPort}` });
    this.log({ component: 'server.websocket', level: 'info', event: 'server.websocket.upgrade.requested', message: 'WebSocket upgrade request received.', connectionId, remoteAddress,
      details: { method: request.method, path: request.url ?? '/', host: request.headers.host, upgrade: request.headers.upgrade, connection: request.headers.connection, websocketVersion: request.headers['sec-websocket-version'] } });
    const client: Client = {
      socket, connectionId, remoteAddress, authenticated: false, deviceId: null, displayName: null,
      sequence: -1, outgoingSequence: 0, pendingAudioMetadata: null, audioStreamId: null, alive: true,
      knownManuscriptHash: null,
      authenticationTimer: setTimeout(() => {
        this.log({ component: 'server.authentication', level: 'warn', event: 'authentication.timeout', message: 'Client did not pair or authenticate before timeout.', connectionId, remoteAddress });
        this.closeClient(client, 1008, 'Authentication timeout');
      }, 10_000), firstFrameSeen: false, audioFramesReceived: 0
    };
    this.clients.set(socket, client);
    this.log({ component: 'server.websocket', level: 'info', event: 'server.websocket.open', message: 'WebSocket connection opened.', connectionId, remoteAddress, websocketState: 'OPEN', details: { path: request.url ?? '/' } });
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (data, binary) => void this.handleMessage(client, data, binary));
    socket.on('close', (code, reason) => {
      this.log({ component: 'server.websocket', level: 'info', event: 'server.websocket.close.received', message: 'WebSocket closed.', connectionId, remoteAddress, websocketState: 'CLOSED', closeCode: code, closeReason: reason.toString() });
      this.removeClient(client);
    });
    socket.on('error', (error) => {
      this.log({ component: 'server.websocket', level: 'error', event: 'server.websocket.error', message: 'WebSocket emitted an error.', connectionId, remoteAddress, ...diagnosticError(error) });
      this.removeClient(client);
    });
    const challenge = this.auth.issue(connectionId);
    this.log({ component: 'server.authentication', level: 'debug', event: 'authentication.challenge.issued', message: 'Fresh authentication challenge issued; value redacted.', connectionId, remoteAddress, serverId: this.options.serverId });
    this.send(client, 'serverChallenge', {
      nonce: challenge.nonce,
      issuedAtMs: challenge.issuedAtMs,
      serverId: this.options.serverId,
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      serverBuild: this.options.buildInfo ?? {
        versionName: this.options.productVersion,
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR
      },
      serverStartedAtMs: this.serverStartedAtMs
    });
  }

  private async handleMessage(client: Client, data: Parameters<WebSocket['send']>[0], binary: boolean) {
    try {
      const byteLength = Buffer.from(data as ArrayBuffer).byteLength;
      if (!client.firstFrameSeen) {
        this.log({
          component: 'server.websocket', level: 'debug', event: binary ? 'server.websocket.binary.received' : 'server.websocket.text.received',
          message: `First ${binary ? 'binary' : 'text'} WebSocket frame received.`, connectionId: client.connectionId, remoteAddress: client.remoteAddress,
          details: { bytes: byteLength, firstFrame: true }
        });
      }
      client.firstFrameSeen = true;
      if (binary) {
        client.audioFramesReceived++;
        if (client.audioFramesReceived === 1 || client.audioFramesReceived % 25 === 0) {
          this.log({
            component: 'server.audio', level: 'debug', event: 'server.audio.frames_progress',
            message: 'Authenticated binary audio streaming remains active.',
            connectionId: client.connectionId, deviceId: client.deviceId ?? undefined,
            details: { framesReceived: client.audioFramesReceived, bytes: byteLength, streamId: client.audioStreamId }
          });
        }
        if (!client.authenticated || !client.deviceId) throw new Error('Unauthenticated binary audio frame.');
        if (this.options.session.getControllerDeviceId() !== client.deviceId) {
          this.log({
            component: 'server.audio', level: 'warn', event: 'server.audio.frame.dropped',
            message: 'Authenticated binary audio frame dropped because the client has no controller lease.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            details: { reason: 'no controller lease', streamId: client.audioStreamId }
          });
          this.manualFollowLog('Authenticated binary audio frame dropped.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            reason: 'no controller lease',
            streamId: client.audioStreamId
          });
          return;
        }
        if (!client.pendingAudioMetadata) {
          this.log({
            component: 'server.audio', level: 'warn', event: 'server.audio.frame.dropped',
            message: 'Authenticated binary audio frame dropped because this connection has no pending metadata.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            details: { reason: 'server metadata missing', streamId: client.audioStreamId }
          });
          this.manualFollowLog('Authenticated binary audio frame dropped.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            reason: 'server metadata missing',
            streamId: client.audioStreamId
          });
          return;
        }
        const metadata = client.pendingAudioMetadata;
        client.pendingAudioMetadata = null;
        try {
          await this.audio.accept(client.deviceId, metadata, Buffer.from(data as ArrayBuffer), client.connectionId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log({
            component: 'server.audio', level: 'warn', event: 'server.audio.frame.dropped',
            message: 'Authenticated binary audio frame was rejected without closing the connection.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            ...diagnosticError(error),
            details: { reason, streamId: metadata.streamId, audioSequence: metadata.sequence }
          });
          this.manualFollowLog('Authenticated binary audio frame dropped.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            reason,
            streamId: metadata.streamId,
            audioSequence: metadata.sequence
          });
        }
        return;
      }
      let message: { type?: string; action?: string; sequence?: number; payload?: unknown } & Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as typeof message;
        if (message.type !== 'audioFrameMetadata') {
          this.log({ component: 'server.protocol', level: 'debug', event: 'protocol.json.decoded', message: 'Text frame decoded as JSON.', connectionId: client.connectionId, remoteAddress: client.remoteAddress,
            protocolMessageType: typeof message.type === 'string' ? message.type : undefined, details: { fields: Object.keys(message).sort() } });
        }
      } catch (error) {
        this.log({ component: 'server.protocol', level: 'warn', event: 'protocol.message.invalid', message: 'Text frame is not valid JSON.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, ...diagnosticError(error) });
        throw error;
      }
      const payload = (message.payload && typeof message.payload === 'object' ? message.payload : message) as Record<string, unknown>;
      if (message.payload) {
        try {
          this.options.protocolValidator?.assert('envelope', message);
          if (message.type !== 'audioFrameMetadata') {
            this.log({ component: 'server.protocol', level: 'debug', event: 'protocol.envelope.valid', message: 'Envelope passed JSON Schema validation.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, protocolMessageType: String(message.type ?? '') });
          }
        } catch (error) {
          this.log({ component: 'server.protocol', level: 'warn', event: 'protocol.message.invalid', message: 'Envelope failed JSON Schema validation.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, protocolMessageType: String(message.type ?? ''), ...diagnosticError(error) });
          throw error;
        }
      }
      const action = String(message.type ?? message.action ?? payload.action ?? '');
      if (action !== 'audioFrameMetadata') {
        this.log({ component: 'server.protocol', level: 'info', event: 'protocol.message.decoded', message: 'Protocol message routed.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, protocolMessageType: action,
          details: { pairingActive: this.options.pairing.getState().active, authenticated: client.authenticated, payloadFields: Object.keys(payload).filter((key) => !/(proof|credential|nonce|code)/i.test(key)).sort() } });
      }
      if (action === 'pairRequest') {
        try { this.options.protocolValidator?.assert('pairing', payload); }
        catch (error) {
          this.log({ component: 'server.pairing', level: 'warn', event: 'pairing.request.rejected', message: 'pairRequest failed schema validation.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, requestId: String(payload.requestId ?? ''), ...diagnosticError(error) });
          throw error;
        }
        const request = payload as unknown as PairRequestPayload;
        this.manualFollowLog('Android client pairing identity received.', {
          connectionId: client.connectionId,
          deviceId: request.deviceId,
          protocol: `${request.protocolMajor}.${request.protocolMinor}`,
          clientBuild: request.clientBuild ?? null
        });
        this.log({ component: 'server.pairing', level: 'info', event: 'pairing.request.received', message: 'pairRequest received.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, requestId: request.requestId, deviceId: request.deviceId,
          details: { pairingActive: this.options.pairing.getState().active, protocolMajor: request.protocolMajor, protocolMinor: request.protocolMinor, hasPairingCode: Boolean(request.pairingCode), model: request.model } });
        if (request.protocolMajor !== PROTOCOL_MAJOR) {
          this.log({ component: 'server.protocol', level: 'warn', event: 'protocol.major_mismatch', message: `Client protocol major ${request.protocolMajor} does not match ${PROTOCOL_MAJOR}.`, connectionId: client.connectionId, deviceId: request.deviceId });
          throw new Error('Protocol major mismatch.');
        }
        const result = await this.options.pairing.request({ ...request, remoteAddress: client.remoteAddress }, request.pairingCode);
        this.log({ component: 'server.pairing', level: result.approved ? 'info' : 'warn', event: result.approved ? 'pairing.approved' : 'pairing.request.rejected',
          message: result.approved ? 'Pairing approved and credential issued; credential redacted.' : result.reason, connectionId: client.connectionId, requestId: request.requestId, deviceId: request.deviceId, remoteAddress: client.remoteAddress });
        this.send(client, result.approved ? 'pairCredential' : 'pairDenied', result);
        if (!result.approved) this.closeClient(client, 1008, safeCloseReason(result.reason));
        return;
      }
      if (action === 'authenticate') {
        try {
          this.options.protocolValidator?.assert('pairing', payload);
          this.manualFollowLog('Android authentication schema validation passed.', {
            connectionId: client.connectionId,
            deviceId: String(payload.deviceId ?? ''),
            protocol: `${String(payload.protocolMajor ?? '?')}.${String(payload.protocolMinor ?? '?')}`
          });
        } catch (error) {
          this.manualFollowLog('Android authentication schema validation failed.', {
            connectionId: client.connectionId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
        const authentication = payload as unknown as AuthenticatePayload;
        this.manualFollowLog('Android client authentication identity received.', {
          connectionId: client.connectionId,
          deviceId: authentication.deviceId,
          protocol: `${authentication.protocolMajor}.${authentication.protocolMinor}`,
          clientBuild: authentication.clientBuild ?? null
        });
        const result = await this.auth.verify(client.connectionId, authentication, client.remoteAddress);
        if (!result.ok) {
          this.authenticationFailures++;
          this.send(client, 'authenticationFailed', { reason: result.reason });
          this.log({ component: 'server.authentication', level: 'warn', event: 'authentication.rejected', message: result.reason, connectionId: client.connectionId, remoteAddress: client.remoteAddress, deviceId: (payload as unknown as AuthenticatePayload).deviceId });
          this.closeClient(client, 1008, safeCloseReason(result.reason));
          this.manualFollowLog('Authentication/controller lease result.', {
            connectionId: client.connectionId,
            authenticated: false,
            controllerLease: false,
            reason: result.reason
          });
          return;
        }
        client.authenticated = true;
        client.deviceId = result.device.deviceId;
        client.displayName = result.device.displayName;
        client.knownManuscriptHash = typeof authentication.cachedManuscriptHash === 'string'
          ? authentication.cachedManuscriptHash
          : null;
        clearTimeout(client.authenticationTimer);
        this.send(client, 'authenticated', { deviceId: client.deviceId });
        if (this.options.session.getControllerDeviceId() === client.deviceId) {
          this.clearControllerDisconnectTimer();
          this.send(client, 'controllerLease', {
            granted: true,
            deviceId: client.deviceId,
            resumed: true,
            connectionGeneration: client.connectionId,
            streamRegistered: false,
            reason: 'Controller lease resumed; audio stream registration is required.'
          });
        }
        this.sendSnapshot(client);
        this.log({ component: 'server.authentication', level: 'info', event: 'authentication.accepted', message: 'Paired device authenticated.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, deviceId: client.deviceId });
        this.manualFollowLog('Authentication/controller lease result.', {
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          authenticated: true,
          controllerLease: this.options.session.getControllerDeviceId() === client.deviceId,
          clientBuild: authentication.clientBuild ?? null
        });
        this.state = 'connected';
        this.emitStatus();
        return;
      }
      if (!client.authenticated || !client.deviceId) throw new Error('Client is not authenticated.');
      const sequence = Number(message.sequence ?? payload.sequence ?? -1);
      if (sequence <= client.sequence) {
        this.log({
          component: 'server.protocol', level: 'warn', event: 'protocol.message.stale',
          message: 'Stale or out-of-order authenticated message ignored.',
          connectionId: client.connectionId, deviceId: client.deviceId, protocolMessageType: action,
          details: { sequence, lastSequence: client.sequence }
        });
        if (action === 'audioStreamStart' && typeof payload.streamId === 'string') {
          const ownsLease = this.options.session.getControllerDeviceId() === client.deviceId;
          this.send(client, 'controllerLease', {
            granted: ownsLease,
            deviceId: client.deviceId,
            streamId: payload.streamId,
            connectionGeneration: client.connectionId,
            streamRegistered: false,
            reason: `Audio stream registration message was out of order (${sequence} <= ${client.sequence}); retry required.`
          });
          this.manualFollowLog('Audio stream registration message ignored as out of order.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            streamId: payload.streamId,
            sequence,
            lastSequence: client.sequence,
            retryRequired: true
          });
        }
        return;
      }
      if (client.sequence >= 0 && sequence > client.sequence + 1) this.sendSnapshot(client);
      client.sequence = sequence;
      if (action === 'requestSnapshot') this.sendSnapshot(client);
      else if (action === 'manualFollowDiagnostic') {
        this.options.protocolValidator?.assert('manualFollowDiagnostic', payload);
        const diagnostic = payload as unknown as TabletManualFollowDiagnosticPayload;
        this.manualFollowLog(`Android ${diagnostic.event}: ${diagnostic.message}`, {
          source: 'android',
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          androidTimestampMs: diagnostic.timestampMs,
          androidSequence: diagnostic.sequence,
          level: diagnostic.level,
          event: diagnostic.event,
          details: diagnostic.details
        });
      }
      else if (action === 'manualReposition') {
        try {
          this.options.protocolValidator?.assert('manualReposition', payload);
          this.manualFollowLog('Manual reposition schema validation passed.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            visibleTokenIndex: Number(payload.visibleTokenIndex),
            manuscriptRevision: Number(payload.manuscriptRevision)
          });
        } catch (error) {
          this.manualFollowLog('Manual reposition schema validation failed.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
        if (this.options.session.getControllerDeviceId() !== client.deviceId) {
          this.manualFollowLog('Manual reposition rejected for controller lease mismatch.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            controllerDeviceId: this.options.session.getControllerDeviceId()
          });
          throw new Error('Tablet does not own the controller lease.');
        }
        const request = payload as unknown as TabletManualRepositionPayload;
        this.manualFollowLog('Manual reposition message received.', {
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          visibleTokenIndex: request.visibleTokenIndex,
          sentenceIndex: request.sentenceIndex,
          paragraphIndex: request.paragraphIndex,
          manuscriptRevision: request.manuscriptRevision,
          direction: request.direction
        });
        this.log({
          component: 'server.movement',
          level: 'info',
          event: 'tablet.manual_scroll.detected',
          message: 'Tablet manual scroll anchor received.',
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          details: {
            scrollContainer: request.scrollContainer,
            inputSource: request.inputSource,
            visibleTokenIndex: request.visibleTokenIndex,
            paragraphIndex: request.paragraphIndex,
            direction: request.direction
          }
        });
        const result = this.options.session.applyTabletManualReposition(client.deviceId, request);
        this.manualFollowLog('Anchor validation and SessionCoordinator rebase result.', {
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          accepted: result.accepted,
          reason: result.reason,
          visibleTokenIndex: result.visibleTokenIndex,
          manuscriptRevision: result.manuscriptRevision,
          sessionRevision: result.sessionRevision,
          coordinatorAnchor: this.options.session.getState()?.manualReacquireAnchor ?? null
        });
        this.send(client, 'manualRepositionAccepted', result);
        this.log({
          component: 'server.coordinator',
          level: result.accepted ? 'info' : 'warn',
          event: result.accepted ? 'coordinator.manual_anchor.accepted' : 'coordinator.manual_anchor.rejected',
          message: result.reason,
          connectionId: client.connectionId,
          deviceId: client.deviceId,
          details: {
            visibleTokenIndex: result.visibleTokenIndex,
            manuscriptRevision: result.manuscriptRevision,
            sessionRevision: result.sessionRevision,
            snapbackPrevented: result.accepted
          }
        });
        this.broadcastSnapshot();
      }
      else if (action === 'audioStreamStart') {
        this.options.protocolValidator?.assert('audio', payload);
        const audioStart = payload as unknown as AudioStreamStartPayload;
        if (!this.options.session.acquireController(client.deviceId)) {
          const reason = 'Desktop transcription or another tablet currently owns the transcript source.';
          this.send(client, 'controllerLease', {
            granted: false,
            deviceId: client.deviceId,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            streamRegistered: false,
            reason
          });
          this.log({
            component: 'server.audio', level: 'warn', event: 'audio.stream.registration_rejected',
            message: reason, connectionId: client.connectionId, deviceId: client.deviceId,
            details: { streamId: audioStart.streamId, connectionGeneration: client.connectionId }
          });
          this.manualFollowLog('Audio stream registration rejected.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            reason
          });
          return;
        }
        this.clearControllerDisconnectTimer();
        try {
          const narration = this.options.session.startTabletNarration(client.deviceId, audioStart.streamId);
          this.log({ component: 'server.session', level: 'info', event: 'session.position.initialized', message: narration.continued ? 'Tablet narration session retained its active start position.' : `Tablet narration start position selected from ${narration.positionSource}.`, connectionId: client.connectionId, deviceId: client.deviceId, details: { manuscriptHash: narration.manuscriptHash, acceptedCharacter: narration.acceptedCharacter, estimatedCharacter: narration.estimatedCharacter, paragraphIndex: narration.paragraphIndex, lastAcceptedTranscriptAtMs: narration.lastAcceptedTranscriptAtMs, narrationSessionId: narration.narrationSessionId, policy: narration.policy, streamId: narration.streamId, leaseId: narration.leaseId } });
          this.log({ component: 'server.session', level: 'info', event: narration.continued ? 'session.position.preserved' : narration.positionSource === 'restored' ? 'session.position.restored' : 'session.position.reset', message: narration.continued ? 'Existing narration session preserved across reconnect.' : `Tablet narration position initialized from ${narration.positionSource}.`, connectionId: client.connectionId, deviceId: client.deviceId, details: { manuscriptHash: narration.manuscriptHash, acceptedCharacter: narration.acceptedCharacter, estimatedCharacter: narration.estimatedCharacter, paragraphIndex: narration.paragraphIndex, lastAcceptedTranscriptAtMs: narration.lastAcceptedTranscriptAtMs, narrationSessionId: narration.narrationSessionId, policy: narration.policy, streamId: narration.streamId, leaseId: narration.leaseId } });
          this.log({ component: 'server.audio', level: 'info', event: 'audio.stream.narration_started', message: narration.continued ? 'Tablet audio stream resumed the active narration session.' : 'Tablet audio stream started a new narration session.', connectionId: client.connectionId, deviceId: client.deviceId, details: { streamId: narration.streamId, narrationSessionId: narration.narrationSessionId, leaseId: narration.leaseId, acceptedCharacter: narration.acceptedCharacter } });
          this.log({ component: 'server.session', level: 'info', event: 'session.position.starting_anchor', message: 'Startup alignment anchor armed for tablet narration.', connectionId: client.connectionId, deviceId: client.deviceId, details: { tokenIndex: this.options.session.getState()?.currentTokenIndex ?? 0, acceptedCharacter: narration.acceptedCharacter, policy: narration.policy } });
          client.pendingAudioMetadata = null;
          client.audioStreamId = audioStart.streamId;
          this.audio.start(client.deviceId, audioStart, client.connectionId);
          this.send(client, 'controllerLease', {
            granted: true,
            deviceId: client.deviceId,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            streamRegistered: true,
            reason: 'Authenticated audio stream registered.'
          });
          this.log({
            component: 'server.audio', level: 'info', event: 'audio.stream.registered',
            message: 'Authenticated controller audio stream registered.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            details: { streamId: audioStart.streamId, connectionGeneration: client.connectionId }
          });
          this.manualFollowLog('Authentication/controller lease result.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            authenticated: true,
            controllerLease: true,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            narrationSessionId: narration.narrationSessionId
          });
          this.sendSnapshot(client);
          this.emitStatus();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          client.pendingAudioMetadata = null;
          client.audioStreamId = null;
          this.audio.stop(client.deviceId, audioStart.streamId, client.connectionId);
          this.send(client, 'controllerLease', {
            granted: false,
            deviceId: client.deviceId,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            streamRegistered: false,
            reason: `Audio stream registration failed: ${reason}`
          });
          this.log({
            component: 'server.audio', level: 'error', event: 'audio.stream.registration_failed',
            message: 'Authenticated audio stream registration failed without closing the connection.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            ...diagnosticError(error),
            details: { streamId: audioStart.streamId, connectionGeneration: client.connectionId, reason }
          });
          this.manualFollowLog('Audio stream registration failed.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            streamId: audioStart.streamId,
            connectionGeneration: client.connectionId,
            reason
          });
        }
      } else if (action === 'audioFrameMetadata') {
        this.options.protocolValidator?.assert('audioMetadata', payload);
        const metadata = payload as unknown as AudioFrameMetadata;
        const rejection = this.audio.metadataRejectionReason(client.deviceId, metadata, client.connectionId);
        if (rejection) {
          client.pendingAudioMetadata = null;
          this.log({
            component: 'server.audio', level: 'warn', event: 'server.audio.metadata.dropped',
            message: 'Audio metadata was rejected without closing the authenticated connection.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            details: { reason: rejection, streamId: metadata.streamId, audioSequence: metadata.sequence }
          });
          this.manualFollowLog('Audio metadata dropped.', {
            connectionId: client.connectionId,
            deviceId: client.deviceId,
            reason: rejection,
            streamId: metadata.streamId,
            audioSequence: metadata.sequence
          });
          return;
        }
        if (client.pendingAudioMetadata) {
          this.log({
            component: 'server.audio', level: 'warn', event: 'server.audio.metadata.replaced',
            message: 'An audio metadata envelope arrived without its binary frame; the stale metadata was replaced.',
            connectionId: client.connectionId, deviceId: client.deviceId,
            details: {
              reason: 'previous metadata had no binary frame',
              previousStreamId: client.pendingAudioMetadata.streamId,
              previousAudioSequence: client.pendingAudioMetadata.sequence,
              replacementStreamId: metadata.streamId,
              replacementAudioSequence: metadata.sequence
            }
          });
        }
        client.pendingAudioMetadata = metadata;
      } else if (action === 'audioStreamStop') {
        this.audio.stop(client.deviceId, client.audioStreamId ?? undefined, client.connectionId);
        client.pendingAudioMetadata = null;
        client.audioStreamId = null;
        this.releaseTabletControl(client.deviceId, 'Tablet stopped its audio stream');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const schemaOrPolicy = /validation|protocol|authenticated|pairing|audio|controller/i.test(reason);
      const closeCode = error instanceof SyntaxError ? 1002 : schemaOrPolicy ? 1008 : 1011;
      this.log({ component: 'server.protocol', level: 'error', event: 'protocol.message.invalid', message: 'Message handling failed; connection will close.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, ...diagnosticError(error), details: { closeCode } });
      this.send(client, 'protocolError', { reason });
      this.closeClient(client, closeCode, safeCloseReason(reason));
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
        this.log({ component: 'server.coordinator', level: 'info', event: 'coordinator.transcript.processed', message: 'Tablet transcript is ready for coordinator processing.', deviceId: chunk.deviceId, details: { audioSequence: chunk.lastSequence, transcriptCharacters: result.text.length } });
        const processed = this.options.session.processTabletTranscript(chunk.deviceId, result.text, chunk.lastSequence);
        const alignmentDebug = processed.state.alignmentBufferDebug;
        this.log({ component: 'server.coordinator', level: 'info', event: 'coordinator.position.accepted', message: 'Coordinator produced the authoritative accepted position.', deviceId: chunk.deviceId, details: { tokenIndex: processed.state.currentTokenIndex, character: processed.state.currentCharacter, sentenceIndex: processed.state.currentSentenceIndex, paragraphIndex: processed.state.currentParagraphIndex, sessionRevision: processed.state.sessionRevision, manuscriptRevision: processed.state.manuscriptRevision, selectedCandidateStartTokenIndex: alignmentDebug.selectedCandidateStartTokenIndex, selectedCandidateEndTokenIndex: alignmentDebug.selectedCandidateEndTokenIndex, newDeltaMatchedWordCount: alignmentDebug.newDeltaMatchedWordCount, newDeltaDistinctiveMatchedWordCount: alignmentDebug.newDeltaDistinctiveMatchedWordCount, commitAccepted: alignmentDebug.moveToTokenCalled, commitRejectedReason: alignmentDebug.commitRejectedReason, lowConfidenceCount: alignmentDebug.lowConfidenceCount, lostOrResyncing: alignmentDebug.lostOrResyncing } });
          if (processed.movement) this.log({ component: 'server.coordinator', level: 'info', event: 'coordinator.movement.produced', message: 'Coordinator produced a semantic movement decision.', deviceId: chunk.deviceId, details: { classification: processed.movement.classification, targetTokenIndex: processed.state.currentTokenIndex, confidence: processed.movement.confidence, manualRepositionStatus: processed.manualReposition?.status ?? null, manualAnchorTokenIndex: processed.manualReposition?.anchorTokenIndex ?? null, manualAnchorDistanceTokens: processed.manualReposition?.distanceTokens ?? null } });
        this.lastTranscript = result.text;
        this.lastMovement = processed.movement;
        const controllerDeviceId = this.options.session.getControllerDeviceId();
        const nonControllerClients = [...this.clients.values()].filter(
          (client) => client.authenticated && client.deviceId !== controllerDeviceId
        );
        if (processed.movement && nonControllerClients.length) {
          this.manualFollowLog('Movement withheld until authenticated client owns controller lease.', {
            controllerDeviceId,
            withheldClients: nonControllerClients.map((client) => ({
              connectionId: client.connectionId,
              deviceId: client.deviceId
            })),
            sessionRevision: processed.state.sessionRevision,
            targetTokenIndex: processed.state.currentTokenIndex
          });
        }
        for (const client of this.clients.values()) if (
          client.authenticated &&
          client.deviceId === controllerDeviceId
        ) {
          this.send(client, 'transcriptEvent', processed.transcript);
          if (processed.movement) {
              this.send(client, 'movementEvent', this.semanticMovement(processed.state, processed.movement, processed.manualReposition));
              this.manualFollowLog('Movement event sent to tablet.', {
                connectionId: client.connectionId,
                deviceId: client.deviceId,
                sessionRevision: processed.state.sessionRevision,
                manuscriptRevision: processed.state.manuscriptRevision,
                targetTokenIndex: processed.state.currentTokenIndex,
                classification: processed.movement.classification,
                manualStatus: processed.manualReposition?.status ?? 'normal',
                manualAnchorTokenIndex: processed.manualReposition?.anchorTokenIndex ?? null,
                manualAnchorDistanceTokens: processed.manualReposition?.distanceTokens ?? null,
                serverBelievesReacquired: processed.manualReposition?.status === 'reacquired'
              });
            this.log({ component: 'server.movement', level: 'info', event: 'server.movement.sent', message: 'Semantic movement event sent to authenticated client.', connectionId: client.connectionId, deviceId: client.deviceId ?? undefined, details: { sessionRevision: processed.state.sessionRevision, manuscriptRevision: processed.state.manuscriptRevision, targetTokenIndex: processed.state.currentTokenIndex, classification: processed.movement.classification } });
          }
          // Transcript and movement events already carry the incremental state.
          // Do not replay the manuscript after every transcription.
        }
      }
    } catch (error) {
      this.recordError(error);
    } finally {
      this.transcriptionActive = false;
    }
  }

  private sendSnapshot(client: Client, provided?: TabletSnapshot | null) {
    const snapshot = provided ?? this.options.session.getSnapshot() as TabletSnapshot | null;
    if (!snapshot) return;
    if (client.knownManuscriptHash === snapshot.manuscript.contentHash) {
      this.send(client, 'sessionState', compactSessionState(snapshot));
      return;
    }
    const messages = tabletSnapshotMessages(snapshot);
    for (const message of messages) this.send(client, message.type, message.payload);
    client.knownManuscriptHash = snapshot.manuscript.contentHash;
    this.log({
      component: 'server.protocol', level: 'info', event: 'server.manuscript.sync.sent',
      message: messages.length === 1 ? 'Tablet manuscript sent in one bounded snapshot.' : 'Tablet manuscript sent as bounded snapshot chunks.',
      connectionId: client.connectionId, deviceId: client.deviceId ?? undefined,
      details: { contentHash: snapshot.manuscript.contentHash, messageCount: messages.length, chunked: messages.length > 1 }
    });
  }

  private send(client: Client, type: string, payload: unknown) {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const state = this.options.session.getState();
    const envelope: ProtocolEnvelope<unknown> = {
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      type,
      serverId: this.options.serverId,
      sessionId: this.options.session.getSessionId(),
      connectionId: client.connectionId,
      sequence: client.outgoingSequence++,
      sentAtMs: Date.now(),
      payload
    };
    const encoded = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > TABLET_MESSAGE_MAX_BYTES) {
      this.log({ component: 'server.protocol', level: 'error', event: 'server.message.oversize_rejected', message: 'Tablet-bound message exceeded the hard outbound budget and was not sent.', connectionId: client.connectionId, remoteAddress: client.remoteAddress,
        protocolMessageType: type, details: { bytes, maxBytes: TABLET_MESSAGE_MAX_BYTES, sequence: envelope.sequence } });
      this.closeClient(client, 1011, 'Outbound message exceeded safety limit');
      return;
    }
    client.socket.send(encoded);
    const large = bytes >= TABLET_MESSAGE_WARN_BYTES;
    this.log({ component: 'server.protocol', level: large ? 'warn' : 'debug', event: large ? 'server.message.large_sent' : 'server.message.sent', message: large ? 'Large tablet-bound protocol envelope sent within the safety budget.' : 'Protocol envelope sent.', connectionId: client.connectionId, remoteAddress: client.remoteAddress,
      protocolMessageType: type, details: { bytes, sequence: envelope.sequence, maxBytes: TABLET_MESSAGE_MAX_BYTES } });
  }

  private semanticMovement(
    state: SessionCoordinatorState,
    movement: MovementDecisionInfo,
    manualReposition: TabletManualRepositionStatus | null
  ) {
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
        reason: movement.reason,
        ...(manualReposition
          ? {
              manualRepositionStatus: manualReposition.status,
              manualAnchorTokenIndex: manualReposition.anchorTokenIndex,
              manualAnchorDistanceTokens: manualReposition.distanceTokens
            }
          : {})
      };
  }

  private removeClient(client: Client) {
    if (!this.clients.delete(client.socket)) return;
    clearTimeout(client.authenticationTimer);
    this.auth.clear(client.connectionId);
    if (client.deviceId) {
      this.audio.stop(client.deviceId, client.audioStreamId ?? undefined, client.connectionId);
      client.pendingAudioMetadata = null;
      client.audioStreamId = null;
      if (this.options.session.getControllerDeviceId() === client.deviceId) {
        const replacement = [...this.clients.values()].some(
          (candidate) => candidate.authenticated && candidate.deviceId === client.deviceId
        );
        if (replacement) {
          this.clearControllerDisconnectTimer();
          this.log({
            component: 'server.mode', level: 'info', event: 'mode.tablet.replacement_connection_retained',
            message: 'Closed socket did not start the controller-release timer because a replacement connection is authenticated.',
            connectionId: client.connectionId, deviceId: client.deviceId
          });
        } else {
          this.scheduleControllerRelease(client.deviceId);
        }
      }
    }
    this.state = this.options.pairing.getState().active ? 'pairing' : this.clients.size ? 'connected' : this.enabled ? 'available' : 'off';
    this.emitStatus();
  }

  private pingClients() {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        this.log({ component: 'server.websocket', level: 'warn', event: 'server.websocket.close.sent', message: 'Heartbeat timed out; terminating unresponsive connection.', connectionId: client.connectionId, deviceId: client.deviceId ?? undefined, closeCode: 1001, closeReason: 'Heartbeat timeout' });
        client.socket.terminate(); continue;
      }
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

  private controllerDisplayName() {
    const deviceId = this.options.session.getControllerDeviceId();
    if (!deviceId) return null;
    return [...this.clients.values()].find((client) => client.deviceId === deviceId)?.displayName
      ?? this.options.devices.list().find((device) => device.deviceId === deviceId)?.displayName
      ?? deviceId;
  }

  private scheduleControllerRelease(deviceId: string) {
    this.clearControllerDisconnectTimer();
    const delayMs = this.options.controllerDisconnectTimeoutMs ?? 10_000;
    this.log({ component: 'server.mode', level: 'warn', event: 'mode.tablet.disconnect_timeout_started', message: 'Controller disconnected; retaining Tablet Mode during reconnect grace period.', deviceId, details: { delayMs } });
    this.controllerDisconnectTimer = setTimeout(() => {
      this.controllerDisconnectTimer = null;
      this.releaseTabletControl(deviceId, 'Tablet disconnect timeout expired');
    }, delayMs);
  }

  private clearControllerDisconnectTimer() {
    if (this.controllerDisconnectTimer) clearTimeout(this.controllerDisconnectTimer);
    this.controllerDisconnectTimer = null;
  }

  private emitStatus() {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }

  private closeClient(client: Client, code: number, reason: string) {
    this.log({ component: 'server.websocket', level: 'info', event: 'server.websocket.close.sent', message: 'Closing WebSocket.', connectionId: client.connectionId, remoteAddress: client.remoteAddress, websocketState: 'CLOSING', closeCode: code, closeReason: reason });
    client.socket.close(code, reason);
  }

  private log(input: Parameters<DiagnosticSink['record']>[0]) { this.options.diagnostics?.record(input); }

  private manualFollowLog(message: string, details: Record<string, unknown>) {
    console.info('[TabletManualFollow]', message, JSON.stringify(details));
    this.log({
      component: 'server.manual-follow',
      level: 'info',
      event: 'tablet.manual_follow.trace',
      message,
      details
    });
  }
}

function safeCloseReason(reason: string) { return reason.replace(/(credential|proof|nonce|challenge)\S*/gi, '[redacted]').slice(0, 120); }

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
