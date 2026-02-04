import { createHash } from 'crypto';
import { z } from 'zod';

export const TenantContextSchema = z.object({
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
});

export function validateTenantContext(tenantId, projectId) {
  if (!/^[a-z0-9-]+$/.test(tenantId)) {
    return { valid: false, error: 'Invalid tenant_id format (lowercase alphanumeric with hyphens only)' };
  }
  if (!/^[a-z0-9-_]+$/.test(projectId)) {
    return { valid: false, error: 'Invalid project_id format (lowercase alphanumeric with hyphens/underscores only)' };
  }
  return { valid: true };
}

export const EventEnvelopeSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createEventEnvelope(params) {
  return {
    event_id: params.event_id,
    event_type: params.event_type,
    occurred_at: params.occurred_at,
    payload: params.payload,
    metadata: params.metadata ?? {},
  };
}

export const RunManifestSchema = z.object({
  run_id: z.string(),
  module_id: z.string(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  outputs: z.array(z.record(z.string(), z.unknown())).default([]),
});

export function createRunManifest(params) {
  return {
    run_id: params.run_id,
    module_id: params.module_id,
    started_at: params.started_at,
    completed_at: params.completed_at,
    outputs: params.outputs ?? [],
  };
}

export const ReportEnvelopeSchema = z.object({
  report_id: z.string(),
  report_type: z.string(),
  generated_at: z.string().datetime(),
  severity: z.string(),
  findings: z.array(z.record(z.string(), z.unknown())),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export function createReportEnvelope(params) {
  return {
    report_id: params.report_id,
    report_type: params.report_type,
    generated_at: params.generated_at,
    severity: params.severity,
    findings: params.findings ?? [],
    metadata: params.metadata ?? {},
  };
}

export const RedactionPatternSchema = z.object({
  label: z.string(),
  pattern: z.instanceof(RegExp),
  replacement: z.string(),
});

export const RedactionHintsSchema = z.object({
  patterns: z.array(RedactionPatternSchema).default([]),
});

export const DEFAULT_REDACTION_PATTERNS = [
  { label: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED_EMAIL]' },
  { label: 'token', pattern: /[a-zA-Z0-9_-]{24,}/g, replacement: '[REDACTED_TOKEN]' },
];

export function createRedactionHints(overrides = []) {
  return { patterns: [...DEFAULT_REDACTION_PATTERNS, ...overrides] };
}

export function redactObject(value, hints = createRedactionHints()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return hints.patterns.reduce((acc, pattern) => acc.replace(pattern.pattern, pattern.replacement), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, hints));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, redactObject(val, hints)])
    );
  }
  return value;
}

export function canonicalizeForHash(input) {
  const serialize = (obj) => {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(serialize);
    if (typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        .reduce((acc, key) => {
          acc[key] = serialize(obj[key]);
          return acc;
        }, {});
    }
    return obj;
  };
  return serialize(input);
}

export function stableHash(input) {
  const canonical = JSON.stringify(canonicalizeForHash(input));
  return createHash('sha256').update(canonical).digest('hex');
}

export function serializeDeterministic(input) {
  return JSON.stringify(canonicalizeForHash(input), null, 2);
}

export const ReportFindingSchema = z.record(z.string(), z.unknown());

export const ReportEnvelope = ReportEnvelopeSchema;

