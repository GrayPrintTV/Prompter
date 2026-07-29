import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtocolValidator } from '../../electron/server/ProtocolValidator';

const root = path.join(process.cwd(), 'shared', 'protocol', 'fixtures', 'android-wire');
const validator = new ProtocolValidator(path.join(process.cwd(), 'shared', 'protocol', 'schemas'));
const read = (name: string) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));

describe('Android wire compatibility', () => {
  it.each([
    ['pair-request.json', 'pairing'],
    ['pair-request-code.json', 'pairing'],
    ['authenticate.json', 'pairing'],
    ['audio-stream-start.json', 'audio']
  ] as const)('accepts real Android codec fixture %s', (name, payloadKind) => {
    const envelope = read(name);
    validator.assert('envelope', envelope);
    validator.assert(payloadKind, envelope.payload);
  });

  it('preserves a leading zero in the six-digit code', () => {
    expect(read('pair-request-code.json').payload.pairingCode).toBe('012345');
  });

  it('accepts Android snapshot request routing envelope', () => {
    const envelope = read('request-snapshot.json');
    validator.assert('envelope', envelope);
    expect(envelope.payload).toEqual({ action: 'requestSnapshot' });
  });
});
