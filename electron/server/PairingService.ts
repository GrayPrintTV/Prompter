import { randomBytes, randomInt } from 'node:crypto';
import type { PairRequestPayload } from '#prompter-shared/protocol/messages.js';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '#prompter-shared/protocol/protocol-version.js';
import type { PairedDeviceRecord, PairedDeviceStore } from './PairedDeviceStore.js';
import type { DiagnosticSink } from './DiagnosticLogService.js';

export type PairingRequestContext = PairRequestPayload & { remoteAddress: string };
export type PairingDecision = { approved: boolean; reason?: string };
export type PairingApprover = (request: PairingRequestContext) => Promise<PairingDecision>;

export type PairingState = {
  active: boolean;
  expiresAt: number | null;
  code: string | null;
  pendingClient: PairingRequestContext | null;
};

export class PairingService {
  private state: PairingState = { active: false, expiresAt: null, code: null, pendingClient: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly failedCodeAttempts = new Map<string, number[]>();
  private readonly listeners = new Set<(state: PairingState) => void>();

  constructor(
    private readonly store: PairedDeviceStore,
    private readonly approver: PairingApprover,
    private readonly now = () => Date.now(),
    private readonly schedule = setTimeout,
    private readonly cancel = clearTimeout,
    private diagnostics?: DiagnosticSink
  ) {}

  setDiagnostics(diagnostics: DiagnosticSink) { this.diagnostics = diagnostics; }

  start(durationMs = 120_000) {
    this.stop();
    this.state = {
      active: true,
      expiresAt: this.now() + durationMs,
      code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
      pendingClient: null
    };
    this.timer = this.schedule(() => this.stop(), durationMs);
    this.log('info', 'pairing.mode.started', 'Pairing mode started.', { expiresAt: this.state.expiresAt });
    this.emit();
    return this.getState();
  }

  stop() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    const changed = this.state.active;
    this.state = { active: false, expiresAt: null, code: null, pendingClient: null };
    if (changed) this.emit();
    if (changed) this.log('info', 'pairing.mode.stopped', 'Pairing mode stopped.');
  }

  getState(): PairingState {
    if (this.state.active && (this.state.expiresAt ?? 0) <= this.now()) this.stop();
    return structuredClone(this.state);
  }

  onState(listener: (state: PairingState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(request: PairingRequestContext, suppliedCode?: string) {
    const expiredBeforeRead = this.state.active && (this.state.expiresAt ?? 0) <= this.now();
    const state = this.getState();
    if (!state.active) {
      this.log('warn', expiredBeforeRead ? 'pairing.code.expired' : 'pairing.request.rejected', expiredBeforeRead ? 'Pairing request arrived after pairing expiry.' : 'Pairing request arrived while pairing mode was inactive.', { ...request });
      return { approved: false, reason: expiredBeforeRead ? 'Pairing code expired.' : 'Pairing mode is not active.' } as const;
    }
    if (suppliedCode !== undefined && !this.verifyCode(request.remoteAddress, suppliedCode)) {
      this.log('warn', 'pairing.code.invalid', 'Pairing code was invalid, expired, or rate limited.', { ...request });
      return { approved: false, reason: 'Pairing code is invalid, expired, or rate limited.' } as const;
    }
    this.state.pendingClient = request;
    this.emit();
    this.log('info', 'pairing.approval.requested', 'Requesting explicit Windows pairing approval.', { ...request });
    const decision = await this.approver(request);
    if (!decision.approved) {
      this.log('warn', 'pairing.denied', decision.reason ?? 'Pairing was denied.', { ...request });
      this.stop();
      return { approved: false, reason: decision.reason ?? 'Pairing was denied.' } as const;
    }
    const credential = randomBytes(32).toString('base64url');
    const record: PairedDeviceRecord = {
      deviceId: request.deviceId,
      displayName: request.deviceName,
      model: request.model ?? 'Unknown model',
      credential,
      createdAt: this.now(),
      lastConnectedAt: null,
      lastKnownAddress: request.remoteAddress,
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR
    };
    await this.store.save(record);
    this.log('info', 'pairing.approved', 'Pairing approved and per-device credential persisted; credential redacted.', { ...request });
    this.stop();
    return { approved: true, deviceId: record.deviceId, credential } as const;
  }

  private verifyCode(address: string, code: string) {
    const cutoff = this.now() - 60_000;
    const attempts = (this.failedCodeAttempts.get(address) ?? []).filter((at) => at >= cutoff);
    if (attempts.length >= 5) return false;
    const valid = code.length === 6 && code === this.state.code && (this.state.expiresAt ?? 0) > this.now();
    if (!valid) {
      attempts.push(this.now());
      this.failedCodeAttempts.set(address, attempts);
    } else {
      this.state.code = null; // one-time use
    }
    return valid;
  }

  private emit() {
    const state = structuredClone(this.state);
    for (const listener of this.listeners) listener(state);
  }

  private log(level: 'info' | 'warn', event: string, message: string, request?: Record<string, unknown>) {
    this.diagnostics?.record({ component: 'server.pairing', level, event, message,
      requestId: typeof request?.requestId === 'string' ? request.requestId : undefined,
      deviceId: typeof request?.deviceId === 'string' ? request.deviceId : undefined,
      remoteAddress: typeof request?.remoteAddress === 'string' ? request.remoteAddress : undefined,
      details: request ? { deviceName: request.deviceName, model: request.model, expiresAt: request.expiresAt } : undefined });
  }
}
