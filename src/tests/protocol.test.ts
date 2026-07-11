import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  checkProtocolCompatibility
} from '../../shared/protocol/protocol-version';
import { buildManuscript } from '../domain/manuscript';
import { SessionCoordinator } from '../session/SessionCoordinator';
import { DEFAULT_DISPLAY_SETTINGS, SAMPLE_MANUSCRIPT } from '../state/appStore';

const protocolRoot = path.join(process.cwd(), 'shared', 'protocol');

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(path.join(protocolRoot, relativePath), 'utf8'));
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const file of [
    'common.schema.json',
    'envelope.schema.json',
    'session-snapshot.schema.json',
    'transcript-event.schema.json',
    'movement-event.schema.json',
    'audio-control.schema.json',
    'pairing-auth.schema.json'
  ]) {
    ajv.addSchema(readJson(path.join('schemas', file)));
  }
  return ajv;
}

describe('shared protocol schemas', () => {
  it('compiles every schema with strict JSON Schema 2020-12 validation', () => {
    const ajv = createValidator();
    expect(ajv.getSchema('https://prompter.local/schemas/envelope.schema.json')).toBeTypeOf('function');
  });

  it('validates the positive snapshot and movement fixtures', () => {
    const ajv = createValidator();
    const envelope = ajv.getSchema('https://prompter.local/schemas/envelope.schema.json')!;
    const snapshot = ajv.getSchema('https://prompter.local/schemas/session-snapshot.schema.json')!;
    const movement = ajv.getSchema('https://prompter.local/schemas/movement-event.schema.json')!;
    const snapshotFixture = readJson('fixtures/valid-session-snapshot.json');
    const movementFixture = readJson('fixtures/valid-movement.json');

    expect(envelope(snapshotFixture)).toBe(true);
    expect(snapshot(snapshotFixture.payload)).toBe(true);
    expect(envelope(movementFixture)).toBe(true);
    expect(movement(movementFixture.payload)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshotFixture))).toEqual(snapshotFixture);
  });

  it('rejects an envelope with a missing required sequence', () => {
    const validate = createValidator().getSchema('https://prompter.local/schemas/envelope.schema.json')!;
    expect(validate(readJson('fixtures/invalid-missing-sequence.json'))).toBe(false);
    expect(validate.errors?.some((error) => error.params.missingProperty === 'sequence')).toBe(true);
  });

  it('requires session and manuscript revisions on semantic movement', () => {
    const validate = createValidator().getSchema('https://prompter.local/schemas/movement-event.schema.json')!;
    const fixture = readJson('fixtures/valid-movement.json');
    delete fixture.payload.sessionRevision;
    delete fixture.payload.manuscriptRevision;
    expect(validate(fixture.payload)).toBe(false);
  });

  it('ignores unknown additive optional fields for same-major minor compatibility', () => {
    const ajv = createValidator();
    const envelope = ajv.getSchema('https://prompter.local/schemas/envelope.schema.json')!;
    const movement = ajv.getSchema('https://prompter.local/schemas/movement-event.schema.json')!;
    const fixture = readJson('fixtures/valid-movement.json');
    fixture.futureEnvelopeHint = true;
    fixture.payload.futureMovementHint = 'optional';
    expect(envelope(fixture)).toBe(true);
    expect(movement(fixture.payload)).toBe(true);
  });

  it('validates the headless coordinator snapshot against the shared snapshot schema', () => {
    const coordinator = new SessionCoordinator({
      manuscript: buildManuscript(SAMPLE_MANUSCRIPT),
      displaySettings: DEFAULT_DISPLAY_SETTINGS
    });
    const snapshot = coordinator.toSerializableSnapshot({
      manuscriptId: 'desktop-session',
      contentHash: 'sha256:fixture'
    });
    const validate = createValidator().getSchema('https://prompter.local/schemas/session-snapshot.schema.json')!;
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('protocol compatibility', () => {
  it('rejects an unsupported major version', () => {
    const fixture = readJson('fixtures/invalid-unsupported-major.json');
    expect(checkProtocolCompatibility(fixture)).toEqual({
      compatible: false,
      reason: `Unsupported protocol major ${fixture.protocolMajor}; expected ${PROTOCOL_MAJOR}.`
    });
  });

  it('accepts same-major additive minor versions and negotiates the lower minor', () => {
    expect(checkProtocolCompatibility({ protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR + 3 })).toEqual({
      compatible: true,
      negotiatedMinor: PROTOCOL_MINOR
    });
  });
});
