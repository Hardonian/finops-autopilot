/**
 * Denylist-based redaction utility for logs and evidence.
 *
 * Keys on the denylist are recursively removed/masked before any
 * data leaves the process boundary (structured logs, artifact files,
 * CLI output).
 */

/** Default key patterns that must never appear in output. */
export const REDACT_DENYLIST_KEYS: readonly string[] = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'authorization',
  'credential',
  'stripe_key',
  'aws_secret',
  'client_secret',
  'refresh_token',
  'session_token',
];

/** Regex patterns that match sensitive values regardless of key name. */
const REDACT_VALUE_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                    // AWS Access Key
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /sk_live_[0-9a-zA-Z]{24,}/,            // Stripe secret key
  /sk-[a-zA-Z0-9]{32,}/,                 // OpenAI-style key
  /ghp_[0-9a-zA-Z]{36}/,                 // GitHub PAT
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Email (PII)
];

const REDACTED = '[REDACTED]';

function keyMatchesDenylist(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_DENYLIST_KEYS.some((dk) => lower.includes(dk));
}

function valueMatchesPattern(value: string): boolean {
  return REDACT_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Deep-redact an object: any key on the denylist is replaced with
 * `[REDACTED]`, any string value matching a sensitive pattern is
 * replaced with `[REDACTED]`.  Returns a new object (never mutates).
 */
export function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return valueMatchesPattern(obj) ? REDACTED : obj;
  }

  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (keyMatchesDenylist(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(value);
    }
  }
  return out;
}

/**
 * Redact a string by replacing inline secret patterns.
 */
export function redactString(input: string): string {
  let result = input;
  result = result.replace(/AKIA[0-9A-Z]{16}/g, REDACTED);
  result = result.replace(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, REDACTED);
  result = result.replace(/sk_live_[0-9a-zA-Z]{24,}/g, REDACTED);
  result = result.replace(/sk-[a-zA-Z0-9]{32,}/g, REDACTED);
  result = result.replace(/ghp_[0-9a-zA-Z]{36}/g, REDACTED);
  result = result.replace(/[a-zA-Z0-9_]+_key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, REDACTED);
  result = result.replace(/[a-zA-Z0-9_]+_token\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, REDACTED);
  result = result.replace(/[a-zA-Z0-9_]+_secret\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, REDACTED);
  return result;
}
