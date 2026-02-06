/**
 * Shared error envelope for all runner commands.
 *
 * Every error that reaches the user goes through this envelope so CLI,
 * logs, and artifact files always have the same shape.
 */

import { redactString } from './redact.js';

// ---- Exit codes (standardised across all *-autopilot runners) --------
export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;
export const EXIT_DEPENDENCY = 3;
export const EXIT_BUG = 4;

// ---- Error envelope --------------------------------------------------

export interface RunnerErrorEnvelope {
  code: string;
  message: string;
  userMessage: string;
  retryable: boolean;
  cause?: string;
  context?: Record<string, unknown>;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'SCHEMA_ERROR'
  | 'IO_ERROR'
  | 'SECURITY_ERROR'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

const CODE_TO_EXIT: Record<ErrorCode, number> = {
  VALIDATION_ERROR: EXIT_VALIDATION,
  SCHEMA_ERROR: EXIT_VALIDATION,
  IO_ERROR: EXIT_DEPENDENCY,
  SECURITY_ERROR: EXIT_VALIDATION,
  TIMEOUT: EXIT_DEPENDENCY,
  NOT_FOUND: EXIT_VALIDATION,
  UPSTREAM_ERROR: EXIT_DEPENDENCY,
  INTERNAL_ERROR: EXIT_BUG,
};

const NON_RETRYABLE = new Set<ErrorCode>([
  'VALIDATION_ERROR',
  'SCHEMA_ERROR',
  'SECURITY_ERROR',
  'NOT_FOUND',
]);

export function exitCodeFor(code: ErrorCode): number {
  return CODE_TO_EXIT[code] ?? EXIT_BUG;
}

export function createErrorEnvelope(
  code: ErrorCode,
  message: string,
  opts: { cause?: unknown; context?: Record<string, unknown> } = {},
): RunnerErrorEnvelope {
  const causeMsg = opts.cause instanceof Error
    ? opts.cause.message
    : opts.cause != null
      ? String(opts.cause)
      : undefined;

  return {
    code,
    message,
    userMessage: redactString(message),
    retryable: !NON_RETRYABLE.has(code),
    cause: causeMsg ? redactString(causeMsg) : undefined,
    context: opts.context,
  };
}

/**
 * Wrap an unknown thrown value into a RunnerErrorEnvelope.
 */
export function wrapError(err: unknown): RunnerErrorEnvelope {
  if (err instanceof Error) {
    return createErrorEnvelope('INTERNAL_ERROR', err.message, { cause: err });
  }
  return createErrorEnvelope('INTERNAL_ERROR', String(err));
}
