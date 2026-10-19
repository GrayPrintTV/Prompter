import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticationService } from '../../electron/server/AuthenticationService';
import { PairedDeviceStore } from '../../electron/server/PairedDeviceStore';
import { PairingService } from '../../electron/server/PairingService';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../../shared/protocol/protocol-version';

const fallbackStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };

async function store() {
  const root = await mkdtemp(path.join(tmpdir(), 'prompter-pairing-'));
  const file = path.join(root, 'devices.json');
  const value = new PairedDeviceStore(file, fallbackStorage);
  await value.load();
  return { value, file };
}

describe('pairing and authentication', () => {
  it('approves once, persists a credential, and authenticates a valid proof', async () => {
    const { value, file } = await store();
    const pairing = new PairingService(value, async () => ({ approved: true }));
    const state = pairing.start();
    const paired = await pairing.request({
      action: 'pairRequest', requestId: 'r1', deviceId: 'tablet-1', deviceName: 'Tablet', model: 'SM-X200',
      pairingCode: state.code!, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR, remoteAddress: '192.168.1.20'
    }, state.code!);
    expect(paired.approved).toBe(true);
    expect(value.diagnostics().credentialStorage).toBe('plaintext-fallback');
    expect(await readFile(file, 'utf8')).not.toContain(paired.approved ? paired.credential : 'impossible');

    const auth = new AuthenticationService('server-1', value, () => 10_000);
    const challenge = auth.issue('connection-1');
    const clientNonce = 'client-nonce';
    const proof = AuthenticationService.createProof(paired.approved ? paired.credential : '', challenge.nonce, clientNonce, 'server-1', 'tablet-1', PROTOCOL_MAJOR);
    const result = await auth.verify('connection-1', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce, timestampMs: 10_000, proof,
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }, '192.168.1.20');
    expect(result.ok).toBe(true);
    expect((await auth.verify('connection-1', {
      action: 'authenticate', deviceId: 'tablet-1', clientNonce, timestampMs: 10_000, proof,
      protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR
    }, '192.168.1.20')).ok).toBe(false);
  });

  it('handles denial, timeout, invalid codes, stale auth, and forgetting', async () => {
    vi.useFakeTimers();
    const { value } = await store();
    const pairing = new PairingService(value, async () => ({ approved: false }));
    const state = pairing.start(1000);
    expect((await pairing.request({
      action: 'pairRequest', requestId: 'r', deviceId: 'x', deviceName: 'X', protocolMajor: 1, protocolMinor: 0,
      remoteAddress: '192.168.1.2'
    }, '000000')).approved).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(pairing.getState().active).toBe(false);
    vi.useRealTimers();
  });

  it('encrypts credentials when safeStorage is available and forgets persisted devices', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-encrypted-'));
    const file = path.join(root, 'devices.json');
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`protected:${value}`),
      decryptString: (value: Buffer) => value.toString().replace('protected:', '')
    };
    const value = new PairedDeviceStore(file, safe);
    await value.save({
      deviceId: 'tablet', displayName: 'Tablet', model: 'SM-X200', credential: 'secret-value', createdAt: 1,
      lastConnectedAt: null, lastKnownAddress: null, protocolMajor: 1, protocolMinor: 0
    });
    expect(value.diagnostics().credentialStorage).toBe('encrypted');
    expect(await readFile(file, 'utf8')).not.toContain('secret-value');
    const reloaded = new PairedDeviceStore(file, safe);
    await reloaded.load();
    expect(reloaded.get('tablet')?.credential).toBe('secret-value');
    await reloaded.forget('tablet');
    expect(reloaded.get('tablet')).toBeNull();
  });

  it('rejects invalid HMACs, stale timestamps, unknown devices, and major mismatches', async () => {
    const { value } = await store();
    await value.save({
      deviceId: 'tablet', displayName: 'Tablet', model: 'SM-X200', credential: 'credential', createdAt: 1,
      lastConnectedAt: null, lastKnownAddress: null, protocolMajor: 1, protocolMinor: 0
    });
    const auth = new AuthenticationService('server-1', value, () => 100_000);
    const payload = { action: 'authenticate' as const, deviceId: 'tablet', clientNonce: 'nonce', timestampMs: 100_000, proof: 'bad', protocolMajor: 1, protocolMinor: 0 };
    auth.issue('bad-proof');
    expect((await auth.verify('bad-proof', payload, '192.168.1.1')).ok).toBe(false);
    auth.issue('stale');
    expect((await auth.verify('stale', { ...payload, timestampMs: 1 }, '192.168.1.2')).ok).toBe(false);
    auth.issue('unknown');
    expect((await auth.verify('unknown', { ...payload, deviceId: 'unknown' }, '192.168.1.3')).ok).toBe(false);
    auth.issue('major');
    expect((await auth.verify('major', { ...payload, protocolMajor: 2 }, '192.168.1.4')).ok).toBe(false);
  });

  it('binds a tablet recovery claim to the authenticated HMAC proof', async () => {
    const { value } = await store();
    const credential = 'recovery-credential';
    await value.save({
      deviceId: 'tablet', displayName: 'Tablet', model: 'SM-X200', credential, createdAt: 1,
      lastConnectedAt: null, lastKnownAddress: null, protocolMajor: 1, protocolMinor: PROTOCOL_MINOR
    });
    const claim = {
      schemaVersion: 1 as const,
      manuscriptId: 'book-1',
      contentHash: `sha256:${'a'.repeat(64)}`,
      manuscriptRevision: 3,
      tokenIndex: 10,
      character: 42,
      sentenceIndex: 2,
      paragraphIndex: 1,
      anchorFingerprint: `sha256:${'b'.repeat(64)}`,
      capturedAtMs: 99_000
    };
    const auth = new AuthenticationService('server-1', value, () => 100_000);
    expect(AuthenticationService.createProof(
      'credential-123', 'challenge-abc', 'nonce-xyz', 'server-1', 'android-device', 1,
      AuthenticationService.recoveryClaimBinding(claim)
    )).toBe('rUKVQ9HiHOp2CMQJQyiwR0vYp4arc1BcQZC-_Bi78Gk');
    const challenge = auth.issue('bound');
    const proof = AuthenticationService.createProof(
      credential, challenge.nonce, 'nonce', 'server-1', 'tablet', PROTOCOL_MAJOR,
      AuthenticationService.recoveryClaimBinding(claim)
    );
    expect((await auth.verify('bound', {
      action: 'authenticate', deviceId: 'tablet', clientNonce: 'nonce', timestampMs: 100_000,
      proof, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR, recoveryClaim: claim
    }, '192.168.1.20')).ok).toBe(true);

    const tamperedChallenge = auth.issue('tampered');
    const tamperedProof = AuthenticationService.createProof(
      credential, tamperedChallenge.nonce, 'nonce-2', 'server-1', 'tablet', PROTOCOL_MAJOR,
      AuthenticationService.recoveryClaimBinding(claim)
    );
    expect((await auth.verify('tampered', {
      action: 'authenticate', deviceId: 'tablet', clientNonce: 'nonce-2', timestampMs: 100_000,
      proof: tamperedProof, protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR,
      recoveryClaim: { ...claim, tokenIndex: 11 }
    }, '192.168.1.21')).ok).toBe(false);
  });

  it('blocks persistence after a parse failure instead of replacing the database with an empty set', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-corrupt-pairing-'));
    const file = path.join(root, 'devices.json');
    const original = '{"version":1,"records":[';
    await writeFile(file, original, 'utf8');
    const audit: Array<{ event: string }> = [];
    const value = new PairedDeviceStore(file, fallbackStorage, (event) => audit.push(event));
    await value.load();
    await expect(value.save({
      deviceId: 'new-tablet', displayName: 'Tablet', model: 'SM-X200', credential: 'secret', createdAt: 1,
      lastConnectedAt: null, lastKnownAddress: null, protocolMajor: 1, protocolMinor: 2
    })).rejects.toThrow('persistence is blocked');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(audit.map((event) => event.event)).toContain('pairing.database.load_failed');
  });

  it('atomically saves and audits pairing and explicit forgetting without credential disclosure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-atomic-pairing-'));
    const file = path.join(root, 'devices.json');
    const audit: Array<{ event: string; message: string }> = [];
    const value = new PairedDeviceStore(file, fallbackStorage, (event) => audit.push(event));
    await value.save({
      deviceId: 'tablet', displayName: 'Tablet', model: 'SM-X200', credential: 'do-not-log', createdAt: 1,
      lastConnectedAt: null, lastKnownAddress: null, protocolMajor: 1, protocolMinor: 2
    });
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await value.forget('tablet');
    expect(audit.map((event) => event.event)).toEqual(expect.arrayContaining([
      'pairing.database.missing', 'pairing.database.device_saved', 'pairing.database.device_forgotten'
    ]));
    expect(JSON.stringify(audit)).not.toContain('do-not-log');
  });
});
