import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatePayload } from '#prompter-shared/protocol/messages.js';
import { PROTOCOL_MAJOR } from '#prompter-shared/protocol/protocol-version.js';
import type { PairedDeviceStore } from './PairedDeviceStore.js';

export type AuthenticationChallenge = { nonce: string; issuedAtMs: number };

export class AuthenticationService {
  private readonly challenges = new Map<string, AuthenticationChallenge>();
  private readonly usedChallenges = new Set<string>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly serverId: string,
    private readonly store: PairedDeviceStore,
    private readonly now = () => Date.now()
  ) {}

  issue(connectionId: string): AuthenticationChallenge {
    const challenge = { nonce: randomBytes(32).toString('base64url'), issuedAtMs: this.now() };
    this.challenges.set(connectionId, challenge);
    return challenge;
  }

  async verify(connectionId: string, payload: AuthenticatePayload, remoteAddress: string) {
    if (payload.protocolMajor !== PROTOCOL_MAJOR) return this.fail(remoteAddress, 'Protocol major mismatch.');
    if (this.isThrottled(remoteAddress)) return { ok: false, reason: 'Authentication attempts are rate limited.' } as const;
    const challenge = this.challenges.get(connectionId);
    if (!challenge || this.usedChallenges.has(challenge.nonce)) return this.fail(remoteAddress, 'Challenge is missing or already used.');
    if (Math.abs(this.now() - payload.timestampMs) > 30_000 || this.now() - challenge.issuedAtMs > 30_000) {
      return this.fail(remoteAddress, 'Authentication timestamp is stale.');
    }
    const record = this.store.get(payload.deviceId);
    if (!record) return this.fail(remoteAddress, 'Unknown or forgotten device.');
    const expected = AuthenticationService.createProof(
      record.credential,
      challenge.nonce,
      payload.clientNonce,
      this.serverId,
      payload.deviceId,
      payload.protocolMajor
    );
    const supplied = Buffer.from(payload.proof, 'base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (supplied.length !== expectedBuffer.length || !timingSafeEqual(supplied, expectedBuffer)) {
      return this.fail(remoteAddress, 'Authentication proof is invalid.');
    }
    this.usedChallenges.add(challenge.nonce);
    if (this.usedChallenges.size > 1_024) {
      const oldest = this.usedChallenges.values().next().value;
      if (oldest) this.usedChallenges.delete(oldest);
    }
    this.challenges.delete(connectionId);
    await this.store.markConnected(payload.deviceId, remoteAddress, payload.protocolMajor, payload.protocolMinor);
    return { ok: true, device: this.store.get(payload.deviceId)! } as const;
  }

  clear(connectionId: string) {
    this.challenges.delete(connectionId);
  }

  static createProof(credential: string, challenge: string, clientNonce: string, serverId: string, deviceId: string, protocolMajor: number) {
    return createHmac('sha256', credential)
      .update([challenge, clientNonce, serverId, deviceId, protocolMajor].join('|'))
      .digest('base64url');
  }

  private fail(address: string, reason: string) {
    const cutoff = this.now() - 60_000;
    const attempts = (this.failures.get(address) ?? []).filter((at) => at >= cutoff);
    attempts.push(this.now());
    this.failures.set(address, attempts);
    return { ok: false, reason } as const;
  }

  private isThrottled(address: string) {
    const cutoff = this.now() - 60_000;
    return (this.failures.get(address) ?? []).filter((at) => at >= cutoff).length >= 8;
  }
}
