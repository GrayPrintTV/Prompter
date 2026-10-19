import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NARRATION_CHECKPOINT_SCHEMA_VERSION,
  NarrationCheckpointStore,
  type NarrationCheckpoint
} from '../../electron/server/NarrationCheckpointStore';
import { ServerSessionBridge } from '../../electron/server/ServerSessionBridge';
import { DEFAULT_DISPLAY_SETTINGS } from '../state/appStore';

const roots: string[] = [];
const checkpoint = (hashByte: string, savedAtMs: number, tokenIndex = 4): NarrationCheckpoint => ({
  schemaVersion: NARRATION_CHECKPOINT_SCHEMA_VERSION,
  manuscriptId: 'desktop:book',
  manuscriptHash: `sha256:${hashByte.repeat(64)}`,
  manuscriptRevision: 0,
  tokenIndex,
  character: tokenIndex * 5,
  sentenceIndex: 0,
  paragraphIndex: 0,
  anchorFingerprint: `sha256:${'f'.repeat(64)}`,
  savedAtMs
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NarrationCheckpointStore', () => {
  it('atomically persists, reloads, and bounds content-addressed checkpoints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prompter-checkpoints-'));
    roots.push(root);
    const file = path.join(root, 'narration-checkpoints.v1.json');
    const store = new NarrationCheckpointStore(file, { debounceMs: 1, maxRecords: 2 });
    store.schedule(checkpoint('a', 1));
    store.schedule(checkpoint('b', 2));
    store.schedule(checkpoint('c', 3));
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).checkpoints).toHaveLength(2);

    const restored = new NarrationCheckpointStore(file, { maxRecords: 2 });
    await restored.load();
    expect(restored.get(`sha256:${'a'.repeat(64)}`)).toBeNull();
    expect(restored.get(`sha256:${'c'.repeat(64)}`)?.tokenIndex).toBe(4);
  });

  it('treats corrupt and structurally invalid files as empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prompter-checkpoints-'));
    roots.push(root);
    const file = path.join(root, 'narration-checkpoints.v1.json');
    await writeFile(file, '{broken', 'utf8');
    const corrupt = new NarrationCheckpointStore(file);
    await corrupt.load();
    expect(corrupt.get(`sha256:${'a'.repeat(64)}`)).toBeNull();

    await writeFile(file, JSON.stringify({ schemaVersion: 1, checkpoints: [{ nope: true }] }), 'utf8');
    const invalid = new NarrationCheckpointStore(file);
    await invalid.load();
    expect(invalid.get(`sha256:${'a'.repeat(64)}`)).toBeNull();
  });

  it('does not rewrite an unchanged position and ignores a partial crash temp file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prompter-checkpoints-'));
    roots.push(root);
    const file = path.join(root, 'narration-checkpoints.v1.json');
    const store = new NarrationCheckpointStore(file, { debounceMs: 60_000 });
    expect(store.schedule(checkpoint('a', 1))).toBe(true);
    await store.flush();
    const first = await readFile(file, 'utf8');
    expect(store.schedule(checkpoint('a', 2))).toBe(false);
    await store.flush();
    expect(await readFile(file, 'utf8')).toBe(first);

    await writeFile(`${file}.tmp`, '{partial', 'utf8');
    const afterCrash = new NarrationCheckpointStore(file);
    await afterCrash.load();
    expect(afterCrash.get(`sha256:${'a'.repeat(64)}`)?.tokenIndex).toBe(4);
  });

  it('restores a new Windows bridge from the durable same-manuscript checkpoint without a tablet', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prompter-checkpoints-'));
    roots.push(root);
    const file = path.join(root, 'narration-checkpoints.v1.json');
    const sync = {
      rendererRevision: 1,
      manuscriptText: 'One two three. Four five six.',
      manuscriptId: 'book-1',
      currentTokenIndex: 0,
      followState: 'following' as const,
      displaySettings: DEFAULT_DISPLAY_SETTINGS,
      selectedProviderId: 'manual' as const,
      transcriptSourceActive: false,
      sessionResetId: 0
    };
    const beforeRestart = new ServerSessionBridge();
    beforeRestart.applyRendererSync(sync);
    const retained = beforeRestart.createCheckpoint(4, 100)!;
    const writer = new NarrationCheckpointStore(file, { debounceMs: 60_000 });
    writer.schedule(retained);
    await writer.flush();

    const reader = new NarrationCheckpointStore(file);
    await reader.load();
    const afterRestart = new ServerSessionBridge();
    afterRestart.applyRendererSync(sync);
    const restored = afterRestart.resolveRecovery(
      'tablet-unavailable',
      null,
      null,
      reader.get(retained.manuscriptHash)
    );
    expect(restored).toEqual(expect.objectContaining({
      source: 'durable-checkpoint',
      acceptedTokenIndex: retained.tokenIndex,
      acceptedCharacter: retained.character
    }));
  });
});
