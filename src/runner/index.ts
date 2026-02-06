/**
 * Runner infrastructure — shared across all CLI commands.
 *
 * Re-exports the standard building blocks every command needs:
 * structured logging, artifact layout, error envelopes, redaction,
 * retry policies, and idempotency helpers.
 */

// Artifacts
export {
  createArtifactWriter,
  generateRunId,
  buildIdempotencyKey,
  findPreviousRun,
  type ArtifactWriter,
  type ArtifactSummary,
} from './artifacts.js';

// Logger
export {
  createLogger,
  type StructuredLogger,
  type LoggerOptions,
  type LogEntry,
  type LogLevel,
} from './logger.js';

// Errors
export {
  createErrorEnvelope,
  wrapError,
  exitCodeFor,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  EXIT_DEPENDENCY,
  EXIT_BUG,
  type RunnerErrorEnvelope,
  type ErrorCode,
} from './errors.js';

// Redaction
export {
  redact,
  redactString,
  REDACT_DENYLIST_KEYS,
} from './redact.js';

// Retry
export {
  withRetry,
  withRetrySync,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type RetryResult,
} from './retry.js';
