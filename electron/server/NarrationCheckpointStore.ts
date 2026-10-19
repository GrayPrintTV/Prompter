import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const NARRATION_CHECKPOINT_SCHEMA_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_RECORDS = 8;

export type NarrationCheckpoint = {
  schemaVersion: typeof NARRATION_CHECKPOINT_SCHEMA_VERSION;
  manuscriptId: string;
  manuscriptHash: string;
  manuscriptRevision: number;
  tokenIndex: number;
  character: number;
  sentenceIndex: number;
  paragraphIndex: number;
  anchorFingerprint: string;
  savedAtMs: number;
};

type CheckpointFile = {
  schemaVersion: typeof NARRATION_CHECKPOINT_SCHEMA_VERSION;
  checkpoints: NarrationCheckpoint[];
};

export type NarrationCheckpointStoreOptions = {
  debounceMs?: number;
  maxRecords?: number;
  onError?: (error: unknown) => void;
};

export class NarrationCheckpointStore {
  private readonly checkpoints = new Map<string, NarrationCheckpoint>();
  private readonly debounceMs: number;
  private readonly maxRecords: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly filePath: string, private readonly options: NarrationCheckpointStoreOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<CheckpointFile>;
      if (parsed.schemaVersion !== NARRATION_CHECKPOINT_SCHEMA_VERSION || !Array.isArray(parsed.checkpoints)) return;
      for (const candidate of parsed.checkpoints) {
        if (!isCheckpoint(candidate)) continue;
        const existing = this.checkpoints.get(candidate.manuscriptHash);
        if (!existing || candidate.savedAtMs > existing.savedAtMs) this.checkpoints.set(candidate.manuscriptHash, candidate);
      }
      this.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.options.onError?.(error);
    }
  }

  get(manuscriptHash: string) {
    const checkpoint = this.checkpoints.get(manuscriptHash);
    return checkpoint ? { ...checkpoint } : null;
  }

  schedule(checkpoint: NarrationCheckpoint) {
    if (!isCheckpoint(checkpoint)) return false;
    const previous = this.checkpoints.get(checkpoint.manuscriptHash);
    if (previous && samePosition(previous, checkpoint)) return false;
    this.checkpoints.set(checkpoint.manuscriptHash, { ...checkpoint });
    this.trim();
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.debounceMs);
    return true;
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
    await this.writeChain;
  }

  private async enqueueWrite() {
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    const snapshot: CheckpointFile = {
      schemaVersion: NARRATION_CHECKPOINT_SCHEMA_VERSION,
      checkpoints: [...this.checkpoints.values()].sort((a, b) => b.savedAtMs - a.savedAtMs)
    };
    this.writeChain = this.writeChain.then(() => this.atomicWrite(snapshot)).catch((error) => {
      this.dirty = true;
      this.options.onError?.(error);
    });
    return this.writeChain;
  }

  private async atomicWrite(value: CheckpointFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.filePath);
  }

  private trim() {
    const retained = [...this.checkpoints.values()]
      .sort((a, b) => b.savedAtMs - a.savedAtMs)
      .slice(0, this.maxRecords);
    this.checkpoints.clear();
    for (const checkpoint of retained) this.checkpoints.set(checkpoint.manuscriptHash, checkpoint);
  }
}

function isCheckpoint(value: unknown): value is NarrationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<NarrationCheckpoint>;
  return checkpoint.schemaVersion === NARRATION_CHECKPOINT_SCHEMA_VERSION &&
    typeof checkpoint.manuscriptId === 'string' && checkpoint.manuscriptId.length > 0 && checkpoint.manuscriptId.length <= 512 &&
    typeof checkpoint.manuscriptHash === 'string' && /^sha256:[a-f0-9]{64}$/i.test(checkpoint.manuscriptHash) &&
    Number.isSafeInteger(checkpoint.manuscriptRevision) && checkpoint.manuscriptRevision! >= 0 &&
    Number.isSafeInteger(checkpoint.tokenIndex) && checkpoint.tokenIndex! >= 0 &&
    Number.isSafeInteger(checkpoint.character) && checkpoint.character! >= 0 &&
    Number.isSafeInteger(checkpoint.sentenceIndex) && checkpoint.sentenceIndex! >= 0 &&
    Number.isSafeInteger(checkpoint.paragraphIndex) && checkpoint.paragraphIndex! >= 0 &&
    typeof checkpoint.anchorFingerprint === 'string' && /^sha256:[a-f0-9]{64}$/i.test(checkpoint.anchorFingerprint) &&
    Number.isSafeInteger(checkpoint.savedAtMs) && checkpoint.savedAtMs! >= 0;
}

function samePosition(a: NarrationCheckpoint, b: NarrationCheckpoint) {
  return a.manuscriptId === b.manuscriptId &&
    a.manuscriptRevision === b.manuscriptRevision &&
    a.tokenIndex === b.tokenIndex &&
    a.character === b.character &&
    a.sentenceIndex === b.sentenceIndex &&
    a.paragraphIndex === b.paragraphIndex &&
    a.anchorFingerprint === b.anchorFingerprint;
}
