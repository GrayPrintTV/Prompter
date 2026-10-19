import { appendFile, appendFileSync, existsSync, mkdir, mkdirSync, readFile, readFileSync, stat, statSync, writeFile, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const MAX_RECORD_BYTES = 128 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;
const DEFAULT_FLUSH_DELAY_MS = 250;
const appendFileAsync = promisify(appendFile);
const mkdirAsync = promisify(mkdir);
const readFileAsync = promisify(readFile);
const statAsync = promisify(stat);
const writeFileAsync = promisify(writeFile);

function boundedLine(record: Record<string, unknown>) {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
    line = `${JSON.stringify({
      timestamp: record.timestamp,
      event: 'diagnostic-record-rejected',
      reason: 'record exceeded bounded JSONL size'
    })}\n`;
  }
  return line;
}

export function appendBoundedJsonLine(
  logPath: string,
  record: Record<string, unknown>,
  maxFileBytes = 4 * 1024 * 1024
) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const line = boundedLine(record);
  if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(line, 'utf8') > maxFileBytes) {
    const content = readFileSync(logPath);
    const tail = content.subarray(Math.max(0, content.length - Math.floor(maxFileBytes / 2)));
    const firstLine = tail.indexOf(0x0a);
    writeFileSync(logPath, firstLine >= 0 ? tail.subarray(firstLine + 1) : Buffer.alloc(0));
  }
  appendFileSync(logPath, line, 'utf8');
}

export class BufferedJsonlLog {
  private queue: string[] = [];
  private queuedBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private droppedRecords = 0;

  constructor(
    private readonly logPath: string,
    private readonly options: {
      maxFileBytes?: number;
      maxBufferBytes?: number;
      flushDelayMs?: number;
      onError?: (error: unknown) => void;
    } = {}
  ) {}

  append(record: Record<string, unknown>) {
    const line = boundedLine(record);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const maxBufferBytes = this.options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (lineBytes > maxBufferBytes || this.queuedBytes + lineBytes > maxBufferBytes) {
      this.droppedRecords += 1;
      this.scheduleFlush();
      return false;
    }
    this.queue.push(line);
    this.queuedBytes += lineBytes;
    this.scheduleFlush();
    return true;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.startFlush();
    await this.writeChain;
    if (this.queue.length) await this.flush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.startFlush();
    }, this.options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
  }

  private startFlush() {
    if (!this.queue.length && !this.droppedRecords) return;
    const lines = this.queue.splice(0);
    this.queuedBytes = 0;
    if (this.droppedRecords) {
      lines.unshift(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'diagnostic-records-dropped', count: this.droppedRecords })}\n`);
      this.droppedRecords = 0;
    }
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdirAsync(path.dirname(this.logPath), { recursive: true });
        const payload = lines.join('');
        const maxFileBytes = this.options.maxFileBytes ?? 4 * 1024 * 1024;
        try {
          const existing = await statAsync(this.logPath);
          if (existing.size + Buffer.byteLength(payload, 'utf8') > maxFileBytes) {
            const content = await readFileAsync(this.logPath);
            const tail = content.subarray(Math.max(0, content.length - Math.floor(maxFileBytes / 2)));
            const firstLine = tail.indexOf(0x0a);
            await writeFileAsync(this.logPath, firstLine >= 0 ? tail.subarray(firstLine + 1) : Buffer.alloc(0));
          }
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await appendFileAsync(this.logPath, payload, 'utf8');
      } catch (error) {
        this.options.onError?.(error);
      }
    });
  }
}
