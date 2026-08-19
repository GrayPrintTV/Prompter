import { describe, expect, it } from 'vitest';
import {
  compactSessionState,
  tabletSnapshotMessages,
  TABLET_MESSAGE_MAX_BYTES,
  type TabletSnapshot
} from '../../electron/server/TabletSnapshotTransport';

function snapshot(wordCount: number): TabletSnapshot {
  const normalizedContent = 'word '.repeat(wordCount).trimEnd();
  const tokens = Array.from({ length: wordCount }, (_, tokenIndex) => {
    const start = tokenIndex * 5;
    return { tokenIndex, sentenceIndex: 0, paragraphIndex: 0, characterRange: { start, end: start + 4 } };
  });
  return {
    sessionRevision: 1,
    manuscriptRevision: 1,
    manuscript: {
      manuscriptId: 'budget-test', contentHash: `sha256:${wordCount}`, normalizedContent,
      paragraphs: [{ paragraphIndex: 0, characterRange: { start: 0, end: normalizedContent.length }, sentenceStart: 0, sentenceEnd: 1 }],
      sentences: [{ sentenceIndex: 0, paragraphIndex: 0, characterRange: { start: 0, end: normalizedContent.length }, tokenStart: 0, tokenEnd: wordCount }],
      tokens
    },
    acceptedPosition: { tokenIndex: 0, character: 0, sentenceIndex: 0, paragraphIndex: 0 },
    followState: 'following', currentConfidence: 1, latestTranscript: '', controllerLease: null,
    displayHints: { readingZonePercent: 38, readingLookaheadTokens: 0, theme: 'dark' },
    movementDecision: null, runtimeSettings: null, narrationSessionId: null
  };
}

function envelopeBytes(type: string, payload: unknown) {
  return Buffer.byteLength(JSON.stringify({
    protocolMajor: 1, protocolMinor: 2, type, serverId: 'server', sessionId: 'session',
    connectionId: 'connection', sequence: 999_999, sentAtMs: Date.now(), payload
  }));
}

describe('tablet snapshot transport budgets', () => {
  it('keeps the normal small-manuscript flow as one snapshot', () => {
    const messages = tabletSnapshotMessages(snapshot(20));
    expect(messages.map((message) => message.type)).toEqual(['sessionSnapshot']);
    expect(envelopeBytes(messages[0].type, messages[0].payload)).toBeLessThanOrEqual(TABLET_MESSAGE_MAX_BYTES);
  });

  it('chunks a 130k-word manuscript with no oversized tablet-bound frame', () => {
    const source = snapshot(130_000);
    const messages = tabletSnapshotMessages(source);
    expect(messages[0].type).toBe('sessionSnapshotStart');
    expect(messages.at(-1)?.type).toBe('sessionSnapshotComplete');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'sessionSnapshot' }));
    expect(Math.max(...messages.map((message) => envelopeBytes(message.type, message.payload))))
      .toBeLessThanOrEqual(TABLET_MESSAGE_MAX_BYTES);

    const content = messages.filter((message) => message.type === 'manuscriptContentChunk')
      .map((message) => (message.payload as { text: string }).text).join('');
    const tokenCount = messages.filter((message) => message.type === 'manuscriptTokenChunk')
      .reduce((count, message) => count + (message.payload as { characterStarts: number[] }).characterStarts.length, 0);
    expect(content).toBe(source.manuscript.normalizedContent);
    expect(tokenCount).toBe(130_000);
  });

  it('uses compact state on reconnect without replaying manuscript text or anchor maps', () => {
    const state = compactSessionState(snapshot(130_000));
    const encoded = JSON.stringify(state);
    expect(encoded).not.toContain('normalizedContent');
    expect(encoded).not.toContain('tokens');
    expect(encoded).not.toContain('sentences');
    expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024);
  });
});
