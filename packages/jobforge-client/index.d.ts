export interface TenantContext {
  tenant_id: string;
  project_id: string;
}

export interface JobRequest {
  job_type: string;
  job_id: string;
  tenant_id: string;
  project_id: string;
  requested_at: string;
  payload: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high' | 'critical';
  max_retries: number;
  timeout_seconds: number;
  metadata?: Record<string, unknown>;
}

export interface JobOptions {
  priority?: JobRequest['priority'];
  maxRetries?: number;
  timeoutSeconds?: number;
  triggeredBy?: string;
  notes?: string;
}

export function buildJobRequest(
  tenantContext: TenantContext,
  jobType: string,
  payload: Record<string, unknown>,
  options?: JobOptions
): JobRequest;

export function createFinOpsReconcileRequest(
  tenantContext: TenantContext,
  periodStart: string,
  periodEnd: string,
  options?: JobOptions
): JobRequest;

export function createFinOpsAnomalyScanRequest(
  tenantContext: TenantContext,
  ledgerPath: string,
  options?: JobOptions
): JobRequest;
