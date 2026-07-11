import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module as unknown as new (options: Record<string, unknown>) => {
  addSchema(schema: unknown): void;
  getSchema(id: string): ValidateFunction | undefined;
};

const SCHEMA_FILES = [
  'common.schema.json', 'envelope.schema.json', 'session-snapshot.schema.json',
  'transcript-event.schema.json', 'movement-event.schema.json', 'audio-control.schema.json',
  'pairing-auth.schema.json'
];

export class ProtocolValidator {
  private readonly validators: Record<string, ValidateFunction>;

  constructor(schemaRoot: string) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const file of SCHEMA_FILES) ajv.addSchema(JSON.parse(readFileSync(path.join(schemaRoot, file), 'utf8')));
    this.validators = {
      envelope: ajv.getSchema('https://prompter.local/schemas/envelope.schema.json')!,
      pairing: ajv.getSchema('https://prompter.local/schemas/pairing-auth.schema.json')!,
      audio: ajv.getSchema('https://prompter.local/schemas/audio-control.schema.json')!,
      audioMetadata: ajv.getSchema('https://prompter.local/schemas/audio-control.schema.json#/$defs/binaryFrameMetadata')!
    };
  }

  assert(kind: keyof ProtocolValidator['validators'], value: unknown) {
    const validate = this.validators[kind];
    if (!validate(value)) throw new Error(`Protocol ${kind} validation failed: ${this.errors(validate)}`);
  }

  private errors(validate: ValidateFunction) {
    return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
  }
}
