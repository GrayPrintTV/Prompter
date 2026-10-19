import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type PairedDeviceRecord = {
  deviceId: string;
  displayName: string;
  model: string;
  credential: string;
  createdAt: number;
  lastConnectedAt: number | null;
  lastKnownAddress: string | null;
  protocolMajor: number;
  protocolMinor: number;
};

type StoredRecord = Omit<PairedDeviceRecord, 'credential'> & {
  credential: string;
  encrypted: boolean;
};

export type SafeStorageAdapter = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type PairingStoreAuditEvent = {
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  deviceId?: string;
  details?: Record<string, unknown>;
};

export class PairedDeviceStore {
  private readonly records = new Map<string, PairedDeviceRecord>();
  private loaded = false;
  private encrypted = false;
  private lastError: string | null = null;
  private persistenceBlocked = false;

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly audit: (event: PairingStoreAuditEvent) => void = () => undefined,
    private readonly fs = { mkdir, readFile, rename, rm, writeFile }
  ) {}

  static underUserData(userDataPath: string, safeStorage: SafeStorageAdapter, audit?: (event: PairingStoreAuditEvent) => void) {
    return new PairedDeviceStore(path.join(userDataPath, 'tablet-server', 'paired-devices.json'), safeStorage, audit);
  }

  async load() {
    if (this.loaded) return;
    this.encrypted = this.safeStorage.isEncryptionAvailable();
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.filePath, 'utf8')) as { records?: StoredRecord[] };
      for (const stored of parsed.records ?? []) {
        try {
          const { encrypted, credential: storedCredential, ...metadata } = stored;
          const credential = encrypted
            ? this.safeStorage.decryptString(Buffer.from(storedCredential, 'base64'))
            : Buffer.from(storedCredential, 'base64').toString('utf8');
          this.records.set(stored.deviceId, { ...metadata, credential });
        } catch (error) {
          this.lastError = `Could not decrypt paired device ${stored.deviceId}: ${error instanceof Error ? error.message : String(error)}`;
          this.persistenceBlocked = true;
          this.audit({ level: 'error', event: 'pairing.database.record_unreadable', message: 'A paired-device record could not be decrypted; persistence is blocked to preserve the database.', deviceId: stored.deviceId });
        }
      }
      this.audit({ level: 'info', event: 'pairing.database.loaded', message: 'Paired-device database loaded.', details: { recordCount: this.records.size, persistenceBlocked: this.persistenceBlocked } });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.audit({ level: 'info', event: 'pairing.database.missing', message: 'No paired-device database exists yet; a new one will be created after explicit pairing.' });
      } else {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.persistenceBlocked = true;
        this.audit({ level: 'error', event: 'pairing.database.load_failed', message: 'Paired-device database could not be read or parsed; persistence is blocked to preserve it.', details: { error: this.lastError } });
      }
    }
    this.loaded = true;
  }

  list() {
    return [...this.records.values()].map((record) => ({ ...record, credential: '[protected]' }));
  }

  get(deviceId: string) {
    const record = this.records.get(deviceId);
    return record ? { ...record } : null;
  }

  async save(record: PairedDeviceRecord) {
    await this.load();
    this.assertPersistenceAllowed();
    const previous = this.records.get(record.deviceId);
    this.records.set(record.deviceId, { ...record });
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.records.set(record.deviceId, previous);
      else this.records.delete(record.deviceId);
      throw error;
    }
    this.audit({ level: 'info', event: 'pairing.database.device_saved', message: 'Paired-device record saved atomically; credential omitted from audit log.', deviceId: record.deviceId, details: { recordCount: this.records.size } });
  }

  async markConnected(deviceId: string, address: string, protocolMajor: number, protocolMinor: number) {
    await this.load();
    this.assertPersistenceAllowed();
    const record = this.records.get(deviceId);
    if (!record) return false;
    const previous = { ...record };
    Object.assign(record, {
      lastConnectedAt: Date.now(),
      lastKnownAddress: address,
      protocolMajor,
      protocolMinor
    });
    try {
      await this.persist();
    } catch (error) {
      this.records.set(deviceId, previous);
      throw error;
    }
    return true;
  }

  async forget(deviceId: string) {
    await this.load();
    this.assertPersistenceAllowed();
    const previous = this.records.get(deviceId);
    const deleted = this.records.delete(deviceId);
    if (deleted) {
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.records.set(deviceId, previous);
        throw error;
      }
      this.audit({ level: 'warn', event: 'pairing.database.device_forgotten', message: 'Paired-device record removed after an explicit forget action.', deviceId, details: { recordCount: this.records.size } });
    }
    return deleted;
  }

  diagnostics() {
    return {
      safeStorageAvailable: this.safeStorage.isEncryptionAvailable(),
      credentialStorage: this.safeStorage.isEncryptionAvailable() ? 'encrypted' as const : 'plaintext-fallback' as const,
      recordCount: this.records.size,
      lastError: this.lastError
    };
  }

  private async persist() {
    this.assertPersistenceAllowed();
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable();
    const records: StoredRecord[] = [...this.records.values()].map((record) => {
      const credential = encryptionAvailable
        ? this.safeStorage.encryptString(record.credential).toString('base64')
        : Buffer.from(record.credential, 'utf8').toString('base64');
      return { ...record, credential, encrypted: encryptionAvailable };
    });
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(temporaryPath, JSON.stringify({ version: 1, encrypted: encryptionAvailable, records }, null, 2), 'utf8');
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    this.encrypted = encryptionAvailable;
  }

  private assertPersistenceAllowed() {
    if (this.persistenceBlocked) throw new Error('Paired-device persistence is blocked because the existing database could not be loaded safely.');
  }
}
