/**
 * Structured JSON-lines logger for runner commands.
 *
 * Every line written to `logs.jsonl` matches the StructuredLogEvent
 * contract from @autopilot/contracts.  The logger also handles
 * automatic redaction of sensitive values.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  action: string;
  message: string;
  tenant_id?: string;
  project_id?: string;
  trace_id?: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  error?: { code: string; message: string; stack?: string };
}

export interface StructuredLogger {
  debug(action: string, message: string, data?: Record<string, unknown>): void;
  info(action: string, message: string, data?: Record<string, unknown>): void;
  warn(action: string, message: string, data?: Record<string, unknown>): void;
  error(action: string, message: string, data?: Record<string, unknown>): void;
  fatal(action: string, message: string, data?: Record<string, unknown>): void;
  flush(): void;
  /** Return all entries collected so far (for summary/artifact output). */
  entries(): readonly LogEntry[];
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LoggerOptions {
  module: string;
  filePath?: string;
  minLevel?: LogLevel;
  json?: boolean;
  tenantId?: string;
  projectId?: string;
  traceId?: string;
}

export function createLogger(opts: LoggerOptions): StructuredLogger {
  const buffer: LogEntry[] = [];
  const minPriority = LEVEL_PRIORITY[opts.minLevel ?? 'info'];

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= minPriority;
  }

  function emit(level: LogLevel, action: string, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: opts.module,
      action,
      message,
      ...(opts.tenantId && { tenant_id: opts.tenantId }),
      ...(opts.projectId && { project_id: opts.projectId }),
      ...(opts.traceId && { trace_id: opts.traceId }),
      ...(data && { data: redact(data) as Record<string, unknown> }),
    };

    buffer.push(entry);

    const line = JSON.stringify(entry);

    // Write to file if configured
    if (opts.filePath) {
      mkdirSync(dirname(opts.filePath), { recursive: true });
      appendFileSync(opts.filePath, line + '\n', 'utf-8');
    }

    // Also write to stderr for human visibility (structured)
    if (opts.json || level === 'error' || level === 'fatal') {
      process.stderr.write(line + '\n');
    }
  }

  return {
    debug: (action, message, data) => emit('debug', action, message, data),
    info: (action, message, data) => emit('info', action, message, data),
    warn: (action, message, data) => emit('warn', action, message, data),
    error: (action, message, data) => emit('error', action, message, data),
    fatal: (action, message, data) => emit('fatal', action, message, data),
    flush: (): void => { /* sync writes, nothing to flush */ },
    entries: (): readonly LogEntry[] => buffer,
  };
}
