/**
 * JobForge Integration
 * 
 * Generates JobForge job requests for batch processing.
 * This module does not execute jobs - it only creates the request payloads.
 * 
 * Refactored to use @autopilot/jobforge-client for suite compatibility.
 */

import {
  type TenantContext,
  type JobRequest,
  buildJobRequest,
  createFinOpsReconcileRequest,
  createFinOpsAnomalyScanRequest,
} from '@autopilot/jobforge-client';
import { buildFinOpsHooks } from './hooks.js';

export interface JobOptions {
  tenantId: string;
  projectId: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  maxRetries?: number;
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}

function toTenantContext(options: JobOptions): TenantContext {
  return {
    tenant_id: options.tenantId,
    project_id: options.projectId,
  };
}

/**
 * Generate a reconciliation job request
 * Uses suite's createFinOpsReconcileRequest with module-specific enhancements
 */
export function createReconcileJob(
  periodStart: string,
  periodEnd: string,
  eventsPath: string,
  options: JobOptions
): JobRequest {
  const tenantContext = toTenantContext(options);
  
  // Use suite's pre-built helper
  const job = createFinOpsReconcileRequest(
    tenantContext,
    periodStart,
    periodEnd,
    {
      priority: options.priority ?? 'normal',
      triggeredBy: 'finops-autopilot',
      notes: `Events source: ${eventsPath}`,
    }
  );

  // Add module-specific payload enhancements
  return {
    ...job,
    payload: {
      ...job.payload,
      operation: 'reconcile',
      finops_hooks: buildFinOpsHooks({
        tenantId: options.tenantId,
        projectId: options.projectId,
        capability: 'mrr_reconcile',
      }),
      events_source: {
        type: 'file',
        path: eventsPath,
        format: 'json',
      },
      output: {
        ledger_path: `./output/ledger-${options.tenantId}-${options.projectId}.json`,
        report_path: `./output/recon-${options.tenantId}-${options.projectId}.json`,
      },
      max_retries: options.maxRetries ?? 3,
      timeout_seconds: options.timeoutSeconds ?? 300,
      ...(options.metadata && { metadata: options.metadata }),
    },
  };
}

/**
 * Generate an anomaly scan job request
 * Uses suite's createFinOpsAnomalyScanRequest with module-specific enhancements
 */
export function createAnomalyScanJob(
  ledgerPath: string,
  options: JobOptions
): JobRequest {
  const tenantContext = toTenantContext(options);
  
  // Use suite's pre-built helper
  const job = createFinOpsAnomalyScanRequest(
    tenantContext,
    ledgerPath,
    {
      priority: options.priority ?? 'normal',
      triggeredBy: 'finops-autopilot',
    }
  );

  // Add module-specific payload enhancements
  return {
    ...job,
    payload: {
      ...job.payload,
      operation: 'anomaly_scan',
      finops_hooks: buildFinOpsHooks({
        tenantId: options.tenantId,
        projectId: options.projectId,
        capability: 'anomaly_detect',
      }),
      ledger_source: {
        type: 'file',
        path: ledgerPath,
        format: 'json',
      },
      thresholds: {
        refund_spike_threshold_cents: 100000,
        dispute_spike_threshold: 5,
        payment_failure_spike_threshold: 0.25,
      },
      output: {
        anomalies_path: `./output/anomalies-${options.tenantId}-${options.projectId}.json`,
      },
      max_retries: options.maxRetries ?? 3,
      timeout_seconds: options.timeoutSeconds ?? 300,
      ...(options.metadata && { metadata: options.metadata }),
    },
  };
}

/**
 * Generate a churn risk report job request
 * Uses suite's buildJobRequest with module-specific job type
 */
export function createChurnRiskJob(
  ledgerPath: string,
  options: JobOptions & { usageMetricsPath?: string; supportTicketsPath?: string }
): JobRequest {
  const tenantContext = toTenantContext(options);
  
  const inputs: Record<string, unknown> = {
    ledger: {
      type: 'file',
      path: ledgerPath,
      format: 'json',
    },
  };

  if (options.usageMetricsPath) {
    inputs.usage_metrics = {
      type: 'file',
      path: options.usageMetricsPath,
      format: 'json',
    };
  }

  if (options.supportTicketsPath) {
    inputs.support_tickets = {
      type: 'file',
      path: options.supportTicketsPath,
      format: 'json',
    };
  }

  // Use suite's generic builder with FinOps-specific job type
  return buildJobRequest(
    tenantContext,
    'autopilot.finops.churn_risk_report',
    {
      operation: 'churn_risk_report',
      finops_hooks: buildFinOpsHooks({
        tenantId: options.tenantId,
        projectId: options.projectId,
        capability: 'churn_assess',
      }),
      inputs,
      weights: {
        payment_failure: 0.3,
        usage_drop: 0.25,
        support_tickets: 0.2,
        plan_downgrade: 0.15,
        inactivity: 0.1,
      },
      output: {
        report_path: `./output/churn-${options.tenantId}-${options.projectId}.json`,
      },
      max_retries: options.maxRetries ?? 3,
      timeout_seconds: options.timeoutSeconds ?? 600,
      ...(options.metadata && { metadata: options.metadata }),
    },
    {
      priority: options.priority ?? 'normal',
      triggeredBy: 'finops-autopilot',
      notes: 'Operational insights only - not financial advice',
    }
  );
}

/**
 * Create a job request from a completed reconciliation report
 */
export function createJobFromReport(
  report: { period_start: string; period_end: string; tenant_id: string; project_id: string },
  options: JobOptions
): JobRequest {
  return createReconcileJob(
    report.period_start,
    report.period_end,
    `./input/events-${report.tenant_id}-${report.project_id}.json`,
    options
  );
}

/**
 * Create a job request from detected anomalies
 */
export function createJobFromAnomalies(
  anomalies: { severity: string; anomaly_id: string }[],
  options: JobOptions & { ledgerPath: string }
): JobRequest {
  const job = createAnomalyScanJob(options.ledgerPath, options);
  
  // Enhance payload with specific anomaly IDs to investigate
  return {
    ...job,
    payload: {
      ...job.payload,
      priority_anomaly_ids: anomalies
        .filter((a) => a.severity === 'critical')
        .map((a) => a.anomaly_id),
    },
  };
}

/**
 * Create a job request from churn risks
 */
export function createJobFromChurnRisks(
  risks: { risk_level: string; customer_id: string }[],
  options: JobOptions & { ledgerPath: string }
): JobRequest {
  const job = createChurnRiskJob(options.ledgerPath, options);
  
  // Enhance with high-risk customer IDs
  return {
    ...job,
    payload: {
      ...job.payload,
      priority_customer_ids: risks
        .filter((r) => r.risk_level === 'critical')
        .map((r) => r.customer_id),
    },
  };
}

/**
 * Serialize job requests to JSON
 */
export function serializeJobRequest(job: JobRequest): string {
  return JSON.stringify(job, null, 2);
}

/**
 * Serialize multiple job requests
 */
export function serializeJobRequests(jobs: JobRequest[]): string {
  return JSON.stringify(jobs, null, 2);
}

// Re-export suite types for convenience
export type { JobRequest, TenantContext } from '@autopilot/jobforge-client';
