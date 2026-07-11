import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export class PairedDeviceStore {
  private readonly records = new Map<string, PairedDeviceRecord>();
  private loaded = false;
  private encrypted = false;
  private lastError: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly fs = { mkdir, readFile, writeFile }
  ) {}

  static underUserData(userDataPath: string, safeStorage: SafeStorageAdapter) {
    return new PairedDeviceStore(path.join(userDataPath, 'tablet-server', 'paired-devices.json'), safeStorage);
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
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.lastError = error instanceof Error ? error.message : String(error);
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
    this.records.set(record.deviceId, { ...record });
    await this.persist();
  }

  async markConnected(deviceId: string, address: string, protocolMajor: number, protocolMinor: number) {
    const record = this.records.get(deviceId);
    if (!record) return false;
    Object.assign(record, {
      lastConnectedAt: Date.now(),
      lastKnownAddress: address,
      protocolMajor,
      protocolMinor
    });
    await this.persist();
    return true;
  }

  async forget(deviceId: string) {
    const deleted = this.records.delete(deviceId);
    if (deleted) await this.persist();
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
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable();
    const records: StoredRecord[] = [...this.records.values()].map((record) => {
      const credential = encryptionAvailable
        ? this.safeStorage.encryptString(record.credential).toString('base64')
        : Buffer.from(record.credential, 'utf8').toString('base64');
      return { ...record, credential, encrypted: encryptionAvailable };
    });
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.fs.writeFile(this.filePath, JSON.stringify({ version: 1, encrypted: encryptionAvailable, records }, null, 2), 'utf8');
    this.encrypted = encryptionAvailable;
  }
}
