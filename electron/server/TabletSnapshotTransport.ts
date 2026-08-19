import { randomUUID } from 'node:crypto';
import type { SerializableSessionSnapshot } from '#prompter-shared/session/SessionCoordinator.js';
import type { RuntimeSettings } from '#prompter-shared/protocol/runtime-settings.js';

export const TABLET_MESSAGE_MAX_BYTES = 256 * 1024;
export const TABLET_MESSAGE_WARN_BYTES = 64 * 1024;

const CONTENT_CHARS_PER_CHUNK = 24 * 1024;
const PARAGRAPHS_PER_CHUNK = 250;
const TOKENS_PER_CHUNK = 750;

export type TabletSnapshot = Omit<SerializableSessionSnapshot, 'controllerLease'> & {
  controllerLease: { deviceId: string; leaseId: string } | null;
  runtimeSettings: RuntimeSettings | null;
  narrationSessionId: string | null;
};

export type TabletTransportMessage = { type: string; payload: unknown };

export function compactSessionState(snapshot: TabletSnapshot) {
  const { manuscript, ...state } = snapshot;
  return {
    ...state,
    manuscript: {
      manuscriptId: manuscript.manuscriptId,
      contentHash: manuscript.contentHash
    }
  };
}

/**
 * A small manuscript remains a single backwards-compatible snapshot. Large
 * manuscripts are transferred as independently bounded frames so OkHttp never
 * has to materialize the former multi-megabyte JSON message.
 */
export function tabletSnapshotMessages(snapshot: TabletSnapshot): TabletTransportMessage[] {
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= TABLET_MESSAGE_MAX_BYTES - 2_048) {
    return [{ type: 'sessionSnapshot', payload: snapshot }];
  }

  const syncId = randomUUID();
  const { manuscript, ...state } = snapshot;
  const contentChunks = chunkString(manuscript.normalizedContent, CONTENT_CHARS_PER_CHUNK);
  const paragraphChunks = chunkArray(manuscript.paragraphs, PARAGRAPHS_PER_CHUNK);
  const tokenChunks = chunkArray(manuscript.tokens, TOKENS_PER_CHUNK);
  const messages: TabletTransportMessage[] = [{
    type: 'sessionSnapshotStart',
    payload: {
      syncId,
      ...state,
      manuscript: {
        manuscriptId: manuscript.manuscriptId,
        contentHash: manuscript.contentHash,
        contentLength: manuscript.normalizedContent.length,
        paragraphCount: manuscript.paragraphs.length,
        tokenCount: manuscript.tokens.length
      },
      chunkCounts: {
        content: contentChunks.length,
        paragraphs: paragraphChunks.length,
        tokens: tokenChunks.length
      }
    }
  }];

  contentChunks.forEach((text, chunkIndex) => messages.push({
    type: 'manuscriptContentChunk',
    payload: { syncId, chunkIndex, chunkCount: contentChunks.length, text }
  }));
  paragraphChunks.forEach((paragraphs, chunkIndex) => messages.push({
    type: 'manuscriptParagraphChunk',
    payload: { syncId, chunkIndex, chunkCount: paragraphChunks.length, paragraphs }
  }));
  tokenChunks.forEach((tokens, chunkIndex) => messages.push({
    type: 'manuscriptTokenChunk',
    payload: {
      syncId,
      chunkIndex,
      chunkCount: tokenChunks.length,
      firstTokenIndex: tokens[0]?.tokenIndex ?? 0,
      sentenceIndexes: tokens.map((token) => token.sentenceIndex),
      paragraphIndexes: tokens.map((token) => token.paragraphIndex),
      characterStarts: tokens.map((token) => token.characterRange.start),
      characterEnds: tokens.map((token) => token.characterRange.end)
    }
  }));
  messages.push({ type: 'sessionSnapshotComplete', payload: { syncId } });
  return messages;
}

function chunkString(value: string, size: number) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  if (!chunks.length) chunks.push('');
  return chunks;
}

function chunkArray<T>(value: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}
