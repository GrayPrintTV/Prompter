import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendBoundedJsonLine } from '../../electron/diagnostics/BoundedJsonlLog';

describe('appendBoundedJsonLine', () => {
  it('rotates on line boundaries and keeps the persisted diagnostic file bounded', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prompter-main-log-'));
    const logPath = path.join(root, 'logs', 'prompter-main.log');

    for (let index = 0; index < 80; index += 1) {
      appendBoundedJsonLine(logPath, { event: 'aggregate', index, payload: 'x'.repeat(80) }, 1_024);
    }

    const content = await readFile(logPath, 'utf8');
    const details = await stat(logPath);
    const lines = content.trim().split('\n').map((line) => JSON.parse(line));
    expect(details.size).toBeLessThanOrEqual(1_024);
    expect(lines.at(-1)).toMatchObject({ event: 'aggregate', index: 79 });
    expect(lines[0].index).toBeGreaterThan(0);
  });
});
