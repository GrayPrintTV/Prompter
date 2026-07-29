export type DiagnosticPlatform = 'windows' | 'android';
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type StructuredDiagnosticEvent = {
  timestampLocal: string;
  timestampMs: number;
  sequence: number;
  platform: DiagnosticPlatform;
  component: string;
  level: DiagnosticLevel;
  event: string;
  message: string;
  connectionId?: string;
  requestId?: string;
  deviceId?: string;
  serverId?: string;
  remoteAddress?: string;
  localAddress?: string;
  websocketState?: string;
  protocolMessageType?: string;
  closeCode?: number;
  closeReason?: string;
  exceptionClass?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
};
