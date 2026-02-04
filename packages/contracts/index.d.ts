import { z } from 'zod';

export const TenantContextSchema: z.ZodObject<{
  tenant_id: z.ZodString;
  project_id: z.ZodString;
}>;
export type TenantContext = z.infer<typeof TenantContextSchema>;
export function validateTenantContext(
  tenantId: string,
  projectId: string
): { valid: boolean; error?: string };

export const EventEnvelopeSchema: z.ZodObject<{
  event_id: z.ZodString;
  event_type: z.ZodString;
  occurred_at: z.ZodString;
  payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type EventMetadata = Record<string, unknown>;
export function createEventEnvelope(params: EventEnvelope): EventEnvelope;

export const RunManifestSchema: z.ZodObject<{
  run_id: z.ZodString;
  module_id: z.ZodString;
  started_at: z.ZodString;
  completed_at: z.ZodOptional<z.ZodString>;
  outputs: z.ZodDefault<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type Output = Record<string, unknown>;
export function createRunManifest(params: RunManifest): RunManifest;

export const ReportEnvelopeSchema: z.ZodObject<{
  report_id: z.ZodString;
  report_type: z.ZodString;
  generated_at: z.ZodString;
  severity: z.ZodString;
  findings: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>;
export type ReportEnvelope = z.infer<typeof ReportEnvelopeSchema>;
export type ReportType = string;
export type Severity = string;
export type EvidenceLink = Record<string, unknown>;
export type Finding = Record<string, unknown>;
export function createReportEnvelope(params: ReportEnvelope): ReportEnvelope;

export const RedactionPatternSchema: z.ZodObject<{
  label: z.ZodString;
  pattern: z.ZodType<RegExp>;
  replacement: z.ZodString;
}>;
export const RedactionHintsSchema: z.ZodObject<{
  patterns: z.ZodDefault<z.ZodArray<typeof RedactionPatternSchema>>;
}>;
export type RedactionPattern = z.infer<typeof RedactionPatternSchema>;
export type RedactionHints = z.infer<typeof RedactionHintsSchema>;
export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[];
export function createRedactionHints(overrides?: RedactionPattern[]): RedactionHints;
export function redactObject<T>(value: T, hints?: RedactionHints): T;

export function canonicalizeForHash<T>(input: T): T;
export function stableHash(input: unknown): string;
export function serializeDeterministic(input: unknown): string;
