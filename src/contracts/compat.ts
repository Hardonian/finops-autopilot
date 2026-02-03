/**
 * JobForge compatibility contracts for finops-autopilot.
 *
 * Migration note: Replace these schemas with direct imports from
 * @autopilot/contracts when JobRequestBundle and ReportEnvelope are available.
 */

import { z } from 'zod';

export const JOBFORGE_SCHEMA_VERSION = '1.0.0';

export const CompatSchemaVersionSchema = z.literal(JOBFORGE_SCHEMA_VERSION);
export const CompatModuleIdSchema = z.enum(['finops']);
export const CompatTenantIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);
export const CompatProjectIdSchema = z.string().min(1).regex(/^[a-z0-9-_]+$/);
export const CompatTraceIdSchema = z.string().min(1);

export const CompatTimestampSchema = z.string().datetime();

export const CompatSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export const CompatJobRequestSchema = z.object({
  job_type: z.string().min(1),
  job_id: z.string().min(1),
  tenant_id: CompatTenantIdSchema,
  project_id: CompatProjectIdSchema,
  requested_at: CompatTimestampSchema,
  payload: z.record(z.unknown()),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  max_retries: z.number().int().min(0).default(3),
  timeout_seconds: z.number().int().min(0).default(300),
  metadata: z.record(z.unknown()).default({}),
});

export const CompatJobRequestWithIdempotencySchema = CompatJobRequestSchema.extend({
  idempotency_key: z.string().min(1),
});

export const CompatCanonicalizationSchema = z.object({
  algorithm: z.literal('sha256'),
  canonical_format: z.literal('json-stable'),
  canonical_hash: z.string().min(1),
});

export const JobRequestBundleSchema = z.object({
  schema_version: CompatSchemaVersionSchema,
  module_id: CompatModuleIdSchema,
  tenant_id: CompatTenantIdSchema,
  project_id: CompatProjectIdSchema,
  trace_id: CompatTraceIdSchema,
  requests: z.array(CompatJobRequestWithIdempotencySchema),
  canonicalization: CompatCanonicalizationSchema,
  metadata: z.record(z.unknown()).default({}),
});

export const ReportFindingSchema = z.object({
  finding_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: CompatSeveritySchema,
  category: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export const ReportSummarySchema = z.object({
  period_start: CompatTimestampSchema.optional(),
  period_end: CompatTimestampSchema.optional(),
  event_count: z.number().int().min(0).default(0),
  normalized_event_count: z.number().int().min(0).default(0),
  ledger_customer_count: z.number().int().min(0).default(0),
  ledger_mrr_cents: z.number().int().min(0).default(0),
  reconciliation_discrepancies: z.number().int().min(0).default(0),
  anomaly_count: z.number().int().min(0).default(0),
  churn_risk_count: z.number().int().min(0).default(0),
  job_request_count: z.number().int().min(0).default(0),
});

export const JobForgeReportEnvelopeSchema = z.object({
  schema_version: CompatSchemaVersionSchema,
  module_id: CompatModuleIdSchema,
  tenant_id: CompatTenantIdSchema,
  project_id: CompatProjectIdSchema,
  trace_id: CompatTraceIdSchema,
  report_id: z.string().min(1),
  generated_at: CompatTimestampSchema,
  report_type: z.literal('finops'),
  summary: ReportSummarySchema,
  findings: z.array(ReportFindingSchema).default([]),
  recommendations: z.array(z.string()).default([]),
  canonicalization: CompatCanonicalizationSchema,
  metadata: z.record(z.unknown()).default({}),
});

export type JobRequestBundle = z.infer<typeof JobRequestBundleSchema>;
export type JobForgeReportEnvelope = z.infer<typeof JobForgeReportEnvelopeSchema>;
export type ReportFinding = z.infer<typeof ReportFindingSchema>;
export type CompatJobRequest = z.infer<typeof CompatJobRequestSchema>;
export type CompatJobRequestWithIdempotency = z.infer<typeof CompatJobRequestWithIdempotencySchema>;
