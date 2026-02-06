import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import {
  redact,
  redactString,
  REDACT_DENYLIST_KEYS,
  createErrorEnvelope,
  wrapError,
  exitCodeFor,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  EXIT_DEPENDENCY,
  EXIT_BUG,
  createArtifactWriter,
  generateRunId,
  buildIdempotencyKey,
  findPreviousRun,
  createLogger,
  withRetrySync,
  DEFAULT_RETRY_POLICY,
} from '../runner/index.js';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('Redaction', () => {
  it('redacts denylist keys in objects', () => {
    const input = {
      name: 'test',
      api_key: 'super-secret-value',
      nested: { password: 'hunter2', safe: 'visible' },
    };
    const result = redact(input) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.api_key).toBe('[REDACTED]');
    expect((result.nested as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((result.nested as Record<string, unknown>).safe).toBe('visible');
  });

  it('redacts sensitive value patterns in strings', () => {
    // Build patterns dynamically to avoid push-protection false positives
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const stripeKey = ['sk', 'live', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ'].join('_');
    const ghToken = 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    expect(redact(awsKey)).toBe('[REDACTED]');
    expect(redact(stripeKey)).toBe('[REDACTED]');
    expect(redact(ghToken)).toBe('[REDACTED]');
    expect(redact('user@example.com')).toBe('[REDACTED]');
  });

  it('does not redact safe strings', () => {
    expect(redact('hello world')).toBe('hello world');
    expect(redact('amount_cents: 500')).toBe('amount_cents: 500');
  });

  it('redacts values in arrays', () => {
    const stripeKey = ['sk', 'live', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ'].join('_');
    const input = ['safe', stripeKey, 'also-safe'];
    const result = redact(input) as string[];
    expect(result[0]).toBe('safe');
    expect(result[1]).toBe('[REDACTED]');
    expect(result[2]).toBe('also-safe');
  });

  it('handles null and undefined', () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('redacts inline secrets from strings via redactString', () => {
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const input = `Found key ${awsKey} in logs`;
    const result = redactString(input);
    expect(result).not.toContain(awsKey);
    expect(result).toContain('[REDACTED]');
  });

  it('denylist covers all required keys', () => {
    const required = ['password', 'secret', 'token', 'api_key', 'private_key', 'credential'];
    for (const key of required) {
      expect(REDACT_DENYLIST_KEYS).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Forbidden patterns test — MUST fail if secrets leak
// ---------------------------------------------------------------------------

describe('Forbidden patterns in output', () => {
  const FORBIDDEN_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,
    /sk_live_[0-9a-zA-Z]{24,}/,
    /sk-[a-zA-Z0-9]{32,}/,
    /ghp_[0-9a-zA-Z]{36}/,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  ];

  // Build dynamically to avoid push-protection false positives
  const sensitiveValues = [
    'AKIA' + 'IOSFODNN7EXAMPLE',
    ['sk', 'live', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ'].join('_'),
    'sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
    'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];

  for (const secret of sensitiveValues) {
    it(`redact() removes forbidden pattern: ${secret.slice(0, 20)}...`, () => {
      const redacted = redact({ data: secret }) as Record<string, unknown>;
      const serialized = JSON.stringify(redacted);
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(serialized)).toBe(false);
      }
    });

    it(`redactString() removes forbidden pattern: ${secret.slice(0, 20)}...`, () => {
      const redacted = redactString(`Message with ${secret} inside`);
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(redacted)).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

describe('Error envelopes', () => {
  it('creates envelope with correct fields', () => {
    const env = createErrorEnvelope('VALIDATION_ERROR', 'Bad input');
    expect(env.code).toBe('VALIDATION_ERROR');
    expect(env.message).toBe('Bad input');
    expect(env.userMessage).toBe('Bad input');
    expect(env.retryable).toBe(false);
  });

  it('marks IO errors as retryable', () => {
    const env = createErrorEnvelope('IO_ERROR', 'Disk full');
    expect(env.retryable).toBe(true);
  });

  it('marks UPSTREAM_ERROR as retryable', () => {
    const env = createErrorEnvelope('UPSTREAM_ERROR', 'Service unavailable');
    expect(env.retryable).toBe(true);
  });

  it('redacts secrets from userMessage', () => {
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const env = createErrorEnvelope('INTERNAL_ERROR', `Key ${awsKey} leaked`);
    expect(env.userMessage).not.toContain(awsKey);
    expect(env.userMessage).toContain('[REDACTED]');
  });

  it('wraps unknown errors', () => {
    const env = wrapError(new Error('boom'));
    expect(env.code).toBe('INTERNAL_ERROR');
    expect(env.message).toBe('boom');
  });

  it('wraps non-Error values', () => {
    const env = wrapError('string error');
    expect(env.code).toBe('INTERNAL_ERROR');
    expect(env.message).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('Exit codes', () => {
  it('maps VALIDATION_ERROR to 2', () => {
    expect(exitCodeFor('VALIDATION_ERROR')).toBe(EXIT_VALIDATION);
  });

  it('maps IO_ERROR to 3', () => {
    expect(exitCodeFor('IO_ERROR')).toBe(EXIT_DEPENDENCY);
  });

  it('maps INTERNAL_ERROR to 4', () => {
    expect(exitCodeFor('INTERNAL_ERROR')).toBe(EXIT_BUG);
  });

  it('constants are correct', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_VALIDATION).toBe(2);
    expect(EXIT_DEPENDENCY).toBe(3);
    expect(EXIT_BUG).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('Artifacts', () => {
  const tmpBase = resolve('/tmp/finops-test-artifacts-' + Date.now());

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('generates unique run IDs', () => {
    const id1 = generateRunId();
    const id2 = generateRunId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  });

  it('builds deterministic idempotency keys', () => {
    const key1 = buildIdempotencyKey(['plan', 'tenant-1', 'project-1']);
    const key2 = buildIdempotencyKey(['plan', 'tenant-1', 'project-1']);
    const key3 = buildIdempotencyKey(['run', 'tenant-1', 'project-1']);
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates artifact directory with expected structure', () => {
    const aw = createArtifactWriter(tmpBase);
    expect(existsSync(aw.dir)).toBe(true);
    expect(existsSync(join(aw.dir, 'evidence'))).toBe(true);
  });

  it('writes evidence files with redaction', () => {
    const aw = createArtifactWriter(tmpBase);
    const path = aw.writeEvidence('test-data', {
      safe: 'value',
      api_key: 'secret-key-123',
    });
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.safe).toBe('value');
    expect(content.api_key).toBe('[REDACTED]');
  });

  it('produces valid summary.json on finalize', () => {
    const aw = createArtifactWriter(tmpBase);
    aw.writeEvidence('step1', { result: 'ok' });

    const summary = aw.finalize({
      command: 'plan',
      startedAt: new Date().toISOString(),
      exitCode: 0,
      idempotencyKey: 'test-key',
      stats: { steps: 1 },
    });

    expect(summary.run_id).toBe(aw.runId);
    expect(summary.command).toBe('plan');
    expect(summary.exit_code).toBe(0);
    expect(summary.files).toContain('logs.jsonl');
    expect(summary.files).toContain('summary.json');
    expect(summary.files.some((f: string) => f.startsWith('evidence/'))).toBe(true);

    // Verify summary.json is on disk
    const onDisk = JSON.parse(readFileSync(join(aw.dir, 'summary.json'), 'utf-8'));
    expect(onDisk.run_id).toBe(aw.runId);
  });

  it('finds previous run by idempotency key', () => {
    const aw = createArtifactWriter(tmpBase);
    aw.finalize({
      command: 'run',
      startedAt: new Date().toISOString(),
      exitCode: 0,
      idempotencyKey: 'idem-123',
    });

    const found = findPreviousRun(tmpBase, 'idem-123');
    expect(found).not.toBeNull();
    expect(found?.idempotency_key).toBe('idem-123');
  });

  it('does not find previous run with different key', () => {
    const aw = createArtifactWriter(tmpBase);
    aw.finalize({
      command: 'run',
      startedAt: new Date().toISOString(),
      exitCode: 0,
      idempotencyKey: 'idem-123',
    });

    const found = findPreviousRun(tmpBase, 'idem-999');
    expect(found).toBeNull();
  });

  it('does not replay failed runs', () => {
    const aw = createArtifactWriter(tmpBase);
    aw.finalize({
      command: 'run',
      startedAt: new Date().toISOString(),
      exitCode: 2,
      idempotencyKey: 'idem-fail',
    });

    const found = findPreviousRun(tmpBase, 'idem-fail');
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Structured Logger
// ---------------------------------------------------------------------------

describe('Structured Logger', () => {
  const tmpBase = resolve('/tmp/finops-test-logger-' + Date.now());

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('writes JSONL entries to file', () => {
    const logPath = join(tmpBase, 'test.jsonl');
    const logger = createLogger({ module: 'test', filePath: logPath });

    logger.info('action1', 'Hello');
    logger.warn('action2', 'Warning');

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.level).toBe('info');
    expect(entry1.module).toBe('test');
    expect(entry1.action).toBe('action1');
    expect(entry1.message).toBe('Hello');
    expect(entry1.timestamp).toBeDefined();
  });

  it('respects minLevel', () => {
    const logPath = join(tmpBase, 'test-level.jsonl');
    const logger = createLogger({ module: 'test', filePath: logPath, minLevel: 'warn' });

    logger.debug('d', 'debug msg');
    logger.info('i', 'info msg');
    logger.warn('w', 'warn msg');
    logger.error('e', 'error msg');

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });

  it('redacts data in log entries', () => {
    const logPath = join(tmpBase, 'test-redact.jsonl');
    const logger = createLogger({ module: 'test', filePath: logPath });

    logger.info('action', 'Test', { password: 'secret123', safe: 'visible' });

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.data.password).toBe('[REDACTED]');
    expect(entry.data.safe).toBe('visible');
  });

  it('tracks entries for summary retrieval', () => {
    const logger = createLogger({ module: 'test' });
    logger.info('a', 'msg1');
    logger.warn('b', 'msg2');
    expect(logger.entries()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('Retry', () => {
  it('succeeds on first attempt', () => {
    const result = withRetrySync(() => 42);
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
  });

  it('retries on failure', () => {
    let calls = 0;
    const result = withRetrySync(() => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
  });

  it('fails after max attempts', () => {
    const result = withRetrySync(
      () => { throw new Error('always fail'); },
      { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
    );
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.errors).toHaveLength(2);
  });
});
