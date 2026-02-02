/**
 * JobForge Integration
 * 
 * Generates JobForge job requests for batch processing.
 * This module does not execute jobs - it only creates the request payloads.
 */

import type {
  JobRequest,
  JobType,
  TenantId,
  ProjectId,
  ReconReport,
  Anomaly,
  ChurnRisk,
} from '../contracts/index.js';
import { JobRequestSchema } from '../contracts/index.js';

export interface JobOptions {
  tenantId: TenantId;
  projectId: ProjectId;
  priority?: 'low' | 'normal' | 'high';
  maxRetries?: number;
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Generate a reconciliation job request
 */
export function createReconcileJob(
  periodStart: string,
  periodEnd: string,
  eventsPath: string,
  options: JobOptions
): JobRequest {
  const jobRequest: JobRequest = {
    job_type: 'autopilot.finops.reconcile',
    job_id: generateJobId('autopilot.finops.reconcile', options.tenantId, options.projectId),
    tenant_id: options.tenantId,
    project_id: options.projectId,
    requested_at: new Date().toISOString(),
    payload: {
      operation: 'reconcile',
      period_start: periodStart,
      period_end: periodEnd,
      events_source: {
        type: 'file',
        path: eventsPath,
        format: 'json',
      },
      output: {
        ledger_path: `./output/ledger-${options.tenantId}-${options.projectId}.json`,
        report_path: `./output/recon-${options.tenantId}-${options.projectId}.json`,
      },
    },
    priority: options.priority ?? 'normal',
    max_retries: options.maxRetries ?? 3,
    timeout_seconds: options.timeoutSeconds ?? 300,
    metadata: {
      ...options.metadata,
      generated_by: 'finops-autopilot',
      version: '1.0.0',
    },
  };

  const validated = JobRequestSchema.safeParse(jobRequest);
  if (!validated.success) {
    throw new Error(`Job request validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}

/**
 * Generate an anomaly scan job request
 */
export function createAnomalyScanJob(
  ledgerPath: string,
  options: JobOptions
): JobRequest {
  const jobRequest: JobRequest = {
    job_type: 'autopilot.finops.anomaly_scan',
    job_id: generateJobId('autopilot.finops.anomaly_scan', options.tenantId, options.projectId),
    tenant_id: options.tenantId,
    project_id: options.projectId,
    requested_at: new Date().toISOString(),
    payload: {
      operation: 'anomaly_scan',
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
    },
    priority: options.priority ?? 'normal',
    max_retries: options.maxRetries ?? 3,
    timeout_seconds: options.timeoutSeconds ?? 300,
    metadata: {
      ...options.metadata,
      generated_by: 'finops-autopilot',
      version: '1.0.0',
    },
  };

  const validated = JobRequestSchema.safeParse(jobRequest);
  if (!validated.success) {
    throw new Error(`Job request validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}

/**
 * Generate a churn risk report job request
 */
export function createChurnRiskJob(
  ledgerPath: string,
  options: JobOptions & { usageMetricsPath?: string; supportTicketsPath?: string }
): JobRequest {
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

  const jobRequest: JobRequest = {
    job_type: 'autopilot.finops.churn_risk_report',
    job_id: generateJobId('autopilot.finops.churn_risk_report', options.tenantId, options.projectId),
    tenant_id: options.tenantId,
    project_id: options.projectId,
    requested_at: new Date().toISOString(),
    payload: {
      operation: 'churn_risk_report',
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
    },
    priority: options.priority ?? 'normal',
    max_retries: options.maxRetries ?? 3,
    timeout_seconds: options.timeoutSeconds ?? 600, // Churn analysis may take longer
    metadata: {
      ...options.metadata,
      generated_by: 'finops-autopilot',
      version: '1.0.0',
      note: 'Operational insights only - not financial advice',
    },
  };

  const validated = JobRequestSchema.safeParse(jobRequest);
  if (!validated.success) {
    throw new Error(`Job request validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}

/**
 * Create a job request from a completed reconciliation report
 */
export function createJobFromReport(
  report: ReconReport,
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
  anomalies: Anomaly[],
  options: JobOptions & { ledgerPath: string }
): JobRequest {
  const job = createAnomalyScanJob(options.ledgerPath, options);
  
  // Enhance payload with specific anomaly IDs to investigate
  return {
    ...job,
    payload: {
      ...job.payload,
      priority_anomaly_ids: anomalies.filter((a) => a.severity === 'critical').map((a) => a.anomaly_id),
    },
  };
}

/**
 * Create a job request from churn risks
 */
export function createJobFromChurnRisks(
  risks: ChurnRisk[],
  options: JobOptions & { ledgerPath: string }
): JobRequest {
  const job = createChurnRiskJob(options.ledgerPath, options);
  
  // Enhance with high-risk customer IDs
  return {
    ...job,
    payload: {
      ...job.payload,
      priority_customer_ids: risks.filter((r) => r.risk_level === 'critical').map((r) => r.customer_id),
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

/**
 * Generate a deterministic job ID
 */
function generateJobId(
  jobType: JobType,
  tenantId: string,
  projectId: string
): string {
  const timestamp = Date.now();
  return `${jobType}:${tenantId}:${projectId}:${timestamp}`;
}
