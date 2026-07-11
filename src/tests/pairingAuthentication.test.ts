import { mkdtemp, readFile } from 'node:fs/promises';
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
});
