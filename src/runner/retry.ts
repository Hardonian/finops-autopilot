/**
 * Retry / back-off policy for external actions.
 *
 * Every external call (file I/O, network, etc.) should be wrapped
 * with `withRetry` so transient failures are handled uniformly.
 */

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
};

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  attempts: number;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with exponential back-off.  Synchronous variant for
 * the current codebase (which is sync-only).
 */
export async function withRetry<T>(
  fn: () => T | Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<RetryResult<T>> {
  const errors: string[] = [];
  let delay = policy.initialDelayMs;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { success: true, value, attempts: attempt, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`attempt ${attempt}: ${msg}`);

      if (attempt < policy.maxAttempts) {
        await sleep(Math.min(delay, policy.maxDelayMs));
        delay *= policy.backoffFactor;
      }
    }
  }

  return { success: false, attempts: policy.maxAttempts, errors };
}

/**
 * Synchronous retry for file-system operations (no await needed).
 */
export function withRetrySync<T>(
  fn: () => T,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryResult<T> {
  const errors: string[] = [];

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = fn();
      return { success: true, value, attempts: attempt, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`attempt ${attempt}: ${msg}`);
      // sync delay not practical; just retry immediately for FS ops
    }
  }

  return { success: false, attempts: policy.maxAttempts, errors };
}
