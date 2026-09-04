import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_RECORD_BYTES = 128 * 1024;

export function appendBoundedJsonLine(
  logPath: string,
  record: Record<string, unknown>,
  maxFileBytes = 4 * 1024 * 1024
) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
    line = `${JSON.stringify({
      timestamp: record.timestamp,
      event: 'diagnostic-record-rejected',
      reason: 'record exceeded bounded JSONL size'
    })}\n`;
  }
  if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(line, 'utf8') > maxFileBytes) {
    const content = readFileSync(logPath);
    const tail = content.subarray(Math.max(0, content.length - Math.floor(maxFileBytes / 2)));
    const firstLine = tail.indexOf(0x0a);
    writeFileSync(logPath, firstLine >= 0 ? tail.subarray(firstLine + 1) : Buffer.alloc(0));
  }
  appendFileSync(logPath, line, 'utf8');
}
