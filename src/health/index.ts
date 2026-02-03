/**
 * Health and capability metadata for JobForge registry integration
 * 
 * Provides:
 * - Health check endpoint responses
 * - Capability metadata for runner discovery
 * - DLQ (Dead Letter Queue) semantics documentation
 * - Capability metadata schema compliance with @autopilot/contracts
 */

import { z } from 'zod';

export const MODULE_ID = 'finops';
export const MODULE_VERSION = '0.1.0';
export const SCHEMA_VERSION = '1.0.0';

// ============================================================================
// Capability Metadata Schemas (Schema Compliance)
// ============================================================================

export const JobTypeCapabilitySchema = z.object({
  job_type: z.string(),
  description: z.string(),
  input_schema: z.string(),
  output_schema: z.string(),
  idempotent: z.boolean(),
  retryable: z.boolean(),
  max_retries: z.number().int().min(0),
  timeout_seconds: z.number().int().min(0),
  required_context: z.array(z.string()),
  deterministic: z.boolean().optional(),
  cacheable: z.boolean().optional(),
  cache_invalidation_rule: z.string().optional(),
});

export const DLQSemanticsSchema = z.object({
  enabled: z.boolean(),
  max_attempts: z.number().int().min(0),
  backoff_strategy: z.enum(['exponential', 'linear', 'fixed']),
  backoff_initial_seconds: z.number().int().min(0),
  backoff_max_seconds: z.number().int().min(0),
  dead_letter_destination: z.string().optional(),
  retryable_errors: z.array(z.string()),
  non_retryable_errors: z.array(z.string()),
});

export const CapabilityMetadataSchema = z.object({
  module_id: z.string(),
  module_version: z.string(),
  schema_version: z.string(),
  job_types: z.array(JobTypeCapabilitySchema),
  input_formats: z.array(z.string()),
  output_formats: z.array(z.string()),
  features: z.array(z.string()),
  dlq_semantics: DLQSemanticsSchema,
});

export const HealthStatusSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  module_id: z.string(),
  module_version: z.string(),
  timestamp: z.string().datetime(),
  checks: z.object({
    contracts: z.boolean(),
    schemas: z.boolean(),
    profiles: z.boolean(),
  }),
  capabilities: z.array(z.string()),
});

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  module_id: string;
  module_version: string;
  timestamp: string;
  checks: {
    contracts: boolean;
    schemas: boolean;
    profiles: boolean;
  };
  capabilities: string[];
}

export interface CapabilityMetadata {
  module_id: string;
  module_version: string;
  schema_version: string;
  job_types: JobTypeCapability[];
  input_formats: string[];
  output_formats: string[];
  features: string[];
  dlq_semantics: DLQSemantics;
}

export interface JobTypeCapability {
  job_type: string;
  description: string;
  input_schema: string;
  output_schema: string;
  idempotent: boolean;
  retryable: boolean;
  max_retries: number;
  timeout_seconds: number;
  required_context: string[];
  deterministic?: boolean;
  cacheable?: boolean;
  cache_invalidation_rule?: string;
}

export interface DLQSemantics {
  enabled: boolean;
  max_attempts: number;
  backoff_strategy: 'exponential' | 'linear' | 'fixed';
  backoff_initial_seconds: number;
  backoff_max_seconds: number;
  dead_letter_destination?: string;
  retryable_errors: string[];
  non_retryable_errors: string[];
}

/**
 * Returns health status for the module
 */
export function getHealthStatus(): HealthStatus {
  const now = new Date().toISOString();
  
  return {
    status: 'healthy',
    module_id: MODULE_ID,
    module_version: MODULE_VERSION,
    timestamp: now,
    checks: {
      contracts: true,
      schemas: true,
      profiles: true,
    },
    capabilities: [
      'billing_ingest',
      'mrr_reconcile',
      'anomaly_detect',
      'churn_assess',
      'jobforge_emit',
    ],
  };
}

/**
 * Returns capability metadata for JobForge registry
 */
export function getCapabilityMetadata(): CapabilityMetadata {
  return {
    module_id: MODULE_ID,
    module_version: MODULE_VERSION,
    schema_version: SCHEMA_VERSION,
    job_types: [
      {
        job_type: 'autopilot.finops.reconcile',
        description: 'Reconcile MRR from billing events',
        input_schema: 'BillingEvent[]',
        output_schema: 'ReconReport',
        idempotent: true,
        retryable: true,
        max_retries: 3,
        timeout_seconds: 300,
        required_context: ['tenant_id', 'project_id', 'period_start', 'period_end'],
      },
      {
        job_type: 'autopilot.finops.anomaly_scan',
        description: 'Detect anomalies in ledger data',
        input_schema: 'LedgerState',
        output_schema: 'Anomaly[]',
        idempotent: true,
        retryable: true,
        max_retries: 3,
        timeout_seconds: 300,
        required_context: ['tenant_id', 'project_id', 'reference_date'],
      },
      {
        job_type: 'autopilot.finops.churn_risk_report',
        description: 'Assess churn risk for customers',
        input_schema: 'ChurnInputs',
        output_schema: 'ChurnRisk[]',
        idempotent: true,
        retryable: true,
        max_retries: 3,
        timeout_seconds: 600,
        required_context: ['tenant_id', 'project_id', 'reference_date'],
      },
      {
        job_type: 'autopilot.finops.cost_snapshot',
        description: 'Generate deterministic cost snapshot for a given period',
        input_schema: 'CostSnapshotInput',
        output_schema: 'CostSnapshotReport',
        idempotent: true,
        retryable: true,
        max_retries: 3,
        timeout_seconds: 300,
        required_context: ['tenant_id', 'project_id', 'period_start', 'period_end'],
        deterministic: true,
        cacheable: true,
        cache_invalidation_rule: 'period_end < now() - 24h OR explicit_invalidation=true',
      },
    ],
    input_formats: ['json'],
    output_formats: ['json', 'markdown'],
    features: [
      'deterministic_output',
      'canonical_hashing',
      'multi_tenant',
      'profile_based_thresholds',
      'jobforge_compatible',
    ],
    dlq_semantics: {
      enabled: true,
      max_attempts: 3,
      backoff_strategy: 'exponential',
      backoff_initial_seconds: 1,
      backoff_max_seconds: 60,
      dead_letter_destination: './dlq/finops',
      retryable_errors: [
        'io_error',
        'timeout',
        'temporary_failure',
      ],
      non_retryable_errors: [
        'validation_error',
        'schema_error',
        'security_error',
        'tenant_mismatch',
      ],
    },
  };
}

/**
 * Validates if a job type is supported by this module
 */
export function isSupportedJobType(jobType: string): boolean {
  const supported = new Set([
    'autopilot.finops.reconcile',
    'autopilot.finops.anomaly_scan',
    'autopilot.finops.churn_risk_report',
    'autopilot.finops.cost_snapshot',
  ]);
  return supported.has(jobType);
}

/**
 * Gets retry policy for a specific error category
 */
export function getRetryPolicy(
  errorCategory: string,
  dlq: DLQSemantics = getCapabilityMetadata().dlq_semantics
): { retryable: boolean; max_attempts: number; backoff_seconds: number } {
  if (dlq.non_retryable_errors.includes(errorCategory)) {
    return { retryable: false, max_attempts: 0, backoff_seconds: 0 };
  }
  
  if (dlq.retryable_errors.includes(errorCategory)) {
    return {
      retryable: true,
      max_attempts: dlq.max_attempts,
      backoff_seconds: dlq.backoff_initial_seconds,
    };
  }
  
  // Default: retryable with caution
  return {
    retryable: true,
    max_attempts: 1,
    backoff_seconds: dlq.backoff_initial_seconds,
  };
}
