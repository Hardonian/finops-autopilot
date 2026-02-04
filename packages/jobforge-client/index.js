export function buildJobRequest(tenantContext, jobType, payload, options = {}) {
  return {
    job_type: jobType,
    job_id: `job-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id: tenantContext.tenant_id,
    project_id: tenantContext.project_id,
    requested_at: new Date().toISOString(),
    payload,
    priority: options.priority ?? 'normal',
    max_retries: options.maxRetries ?? 3,
    timeout_seconds: options.timeoutSeconds ?? 300,
    metadata: {
      triggered_by: options.triggeredBy,
      notes: options.notes,
    },
  };
}

export function createFinOpsReconcileRequest(tenantContext, periodStart, periodEnd, options = {}) {
  return buildJobRequest(
    tenantContext,
    'autopilot.finops.reconcile',
    {
      period_start: periodStart,
      period_end: periodEnd,
    },
    options
  );
}

export function createFinOpsAnomalyScanRequest(tenantContext, ledgerPath, options = {}) {
  return buildJobRequest(
    tenantContext,
    'autopilot.finops.anomaly_scan',
    {
      ledger_path: ledgerPath,
    },
    options
  );
}
