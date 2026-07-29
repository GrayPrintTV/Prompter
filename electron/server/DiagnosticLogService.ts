import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StructuredDiagnosticEvent } from '#prompter-shared/protocol/diagnostics.js';

export type DiagnosticInput = Omit<StructuredDiagnosticEvent, 'timestampLocal' | 'timestampMs' | 'sequence' | 'platform'>;
export type DiagnosticSink = { record(input: DiagnosticInput): StructuredDiagnosticEvent };

const SECRET_KEY = /(credential|proof|challenge|nonce|pairingcode|audio|pcm|manuscript|content)/i;

export class DiagnosticLogService implements DiagnosticSink {
  private readonly events: StructuredDiagnosticEvent[] = [];
  private readonly listeners = new Set<(event: StructuredDiagnosticEvent) => void>();
  private sequence = 0;
  private pausedPersistenceError = false;

  constructor(
    readonly logDirectory: string,
    private readonly maxEvents = 1_000,
    private readonly maxFileBytes = 2 * 1024 * 1024
  ) { mkdirSync(logDirectory, { recursive: true }); }

  get logPath() { return path.join(this.logDirectory, 'tablet-server.ndjson'); }

  record(input: DiagnosticInput) {
    const timestampMs = Date.now();
    const event: StructuredDiagnosticEvent = {
      ...input,
      timestampLocal: new Date(timestampMs).toLocaleString(),
      timestampMs,
      sequence: ++this.sequence,
      platform: 'windows',
      connectionId: shorten(input.connectionId), requestId: shorten(input.requestId),
      deviceId: shorten(input.deviceId), serverId: shorten(input.serverId),
      details: redact(input.details)
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    try {
      this.rotateIfNeeded();
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, 'utf8');
      this.pausedPersistenceError = false;
    } catch (error) {
      if (!this.pausedPersistenceError) console.warn('[tablet diagnostics] persistence failed', error);
      this.pausedPersistenceError = true;
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  list() { return this.events.map((event) => structuredClone(event)); }
  clearView() { this.events.length = 0; }
  onEvent(listener: (event: StructuredDiagnosticEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  format(events = this.events) { return events.map(formatDiagnosticEvent).join('\n'); }

  recentPersistedText() {
    try { return existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8') : ''; }
    catch { return ''; }
  }

  private rotateIfNeeded() {
    if (!existsSync(this.logPath) || statSync(this.logPath).size < this.maxFileBytes) return;
    const content = readFileSync(this.logPath);
    const tail = content.subarray(Math.max(0, content.length - Math.floor(this.maxFileBytes / 2)));
    const firstLine = tail.indexOf(0x0a);
    writeFileSync(this.logPath, firstLine >= 0 ? tail.subarray(firstLine + 1) : tail);
  }
}

export function diagnosticError(error: unknown) {
  return {
    exceptionClass: error instanceof Error ? error.constructor.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error)
  };
}

export function formatDiagnosticEvent(event: StructuredDiagnosticEvent) {
  const context = [event.connectionId && `conn=${event.connectionId}`, event.protocolMessageType && `type=${event.protocolMessageType}`,
    event.remoteAddress && `remote=${event.remoteAddress}`, event.closeCode !== undefined && `close=${event.closeCode}`].filter(Boolean).join(' ');
  const details = event.details && Object.keys(event.details).length ? ` ${JSON.stringify(event.details)}` : '';
  return `${event.timestampLocal} #${event.sequence} ${event.level.toUpperCase()} [${event.component}] ${event.event}${context ? ` ${context}` : ''} — ${event.message}${details}`;
}

function shorten(value?: string) { return value && value.length > 10 ? `${value.slice(0, 8)}…` : value; }
function redact(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (SECRET_KEY.test(key) && !/^(manuscriptRevision|manuscriptHash|audioSequence)$/i.test(key)) return [key, '[redacted]'];
    if (typeof item === 'string' && item.length > 300) return [key, `${item.slice(0, 300)}…`];
    if (item && typeof item === 'object') return [key, redact(item)];
    return [key, item];
  }));
}
