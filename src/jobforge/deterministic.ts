import { createHash } from 'crypto';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeJson(value[key]);
    }
    return result;
  }

  return value;
}

export function serializeCanonical(value: unknown, space = 2): string {
  return JSON.stringify(canonicalizeJson(value), null, space);
}

export function hashCanonical(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return createHash('sha256').update(canonical).digest('hex');
}

export function withCanonicalization<T extends Record<string, unknown>>(
  value: T
): { payload: T; canonicalization: { algorithm: 'sha256'; canonical_format: 'json-stable'; canonical_hash: string } } {
  const canonical_hash = hashCanonical(value);
  return {
    payload: value,
    canonicalization: {
      algorithm: 'sha256',
      canonical_format: 'json-stable',
      canonical_hash,
    },
  };
}
