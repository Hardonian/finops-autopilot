import { z } from 'zod';
import { ingestEvents } from '../ingest/index.js';
import { buildLedger, reconcileMrr } from '../reconcile/index.js';
import { detectAnomalies } from '../anomalies/index.js';
import { assessChurnRisk } from '../churn/index.js';
import { getProfile } from '../profiles/index.js';
import {
  BillingEventSchema,
  ChurnInputsSchema,
  EventEnvelopeSchema,
  LedgerStateSchema,
  NormalizedEventSchema,
  RunManifestSchema,
} from '../contracts/index.js';
import {
  JobRequestBundleSchema,
  JobForgeReportEnvelopeSchema,
  JOBFORGE_SCHEMA_VERSION,
  type JobForgeReportEnvelope,
  type JobRequestBundle,
  type ReportFinding,
} from '../contracts/compat.js';
import type { JobOptions, JobRequest } from './requests.js';
import { hashCanonical, serializeCanonical, withCanonicalization } from './deterministic.js';

const DEFAULT_SCHEMA_VERSION = JOBFORGE_SCHEMA_VERSION;
const MODULE_ID = 'finops';
const STABLE_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DEFAULT_PERIOD_START = '2024-01-01T00:00:00.000Z';
const DEFAULT_PERIOD_END = '2024-01-31T23:59:59.999Z';

const JobRequestInputsSchema = z.object({
  reconcile: z
    .object({
      events_path: z.string().min(1),
    })
    .optional(),
  anomaly_scan: z
    .object({
      ledger_path: z.string().min(1),
    })
    .optional(),
  churn_risk: z
    .object({
      ledger_path: z.string().min(1),
      usage_metrics_path: z.string().min(1).optional(),
      support_tickets_path: z.string().min(1).optional(),
    })
    .optional(),
});

export const AnalyzeInputsSchema = z.object({
  schema_version: z.string().min(1).default(DEFAULT_SCHEMA_VERSION),
  module_id: z.literal(MODULE_ID).default(MODULE_ID),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
  trace_id: z.string().min(1),
  period_start: z.string().datetime().optional(),
  period_end: z.string().datetime().optional(),
  reference_date: z.string().datetime().optional(),
  event_envelopes: z.array(EventEnvelopeSchema).optional(),
  run_manifests: z.array(RunManifestSchema).optional(),
  billing_events: z.array(BillingEventSchema).optional(),
  normalized_events: z.array(NormalizedEventSchema).optional(),
  ledger: LedgerStateSchema.optional(),
  churn_inputs: ChurnInputsSchema.optional(),
  job_requests: JobRequestInputsSchema.default({}),
  profile: z.string().optional(),
});

export type AnalyzeInputs = z.infer<typeof AnalyzeInputsSchema>;

export interface AnalyzeOptions {
  stableOutput?: boolean;
}

export interface ValidationResult {
  success: boolean;
  errors: string[];
}

function derivePeriod(events: { timestamp: string }[] | undefined): { periodStart: string; periodEnd: string } {
  if (!events || events.length === 0) {
    return { periodStart: DEFAULT_PERIOD_START, periodEnd: DEFAULT_PERIOD_END };
  }

  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    periodStart: sorted[0]?.timestamp ?? DEFAULT_PERIOD_START,
    periodEnd: sorted[sorted.length - 1]?.timestamp ?? DEFAULT_PERIOD_END,
  };
}

function ensureStableTimestamp(timestamp: string | undefined, stableOutput?: boolean): string {
  if (stableOutput) {
    return STABLE_TIMESTAMP;
  }
  return timestamp ?? new Date().toISOString();
}

function normalizeJobRequest(
  job: JobRequest,
  options: JobOptions & { traceId: string; stableOutput?: boolean }
): JobRequest & { idempotency_key: string } {
  const idempotencyKey = hashCanonical({
    job_type: job.job_type,
    tenant_id: options.tenantId,
    project_id: options.projectId,
    payload: job.payload,
  });

  const jobId = `job-${idempotencyKey.slice(0, 16)}`;

  return {
    ...job,
    job_id: jobId,
    tenant_id: options.tenantId,
    project_id: options.projectId,
    requested_at: ensureStableTimestamp(job.requested_at, options.stableOutput),
    metadata: {
      ...(job.metadata ?? {}),
      trace_id: options.traceId,
      module_id: MODULE_ID,
      jobforge_dry_run: true,
      requires_policy_token: false,
      job_type_status: 'AVAILABLE',
    },
    idempotency_key: idempotencyKey,
  };
}

function toJobOptions(inputs: AnalyzeInputs, stableOutput?: boolean): JobOptions & { traceId: string; stableOutput?: boolean } {
  return {
    tenantId: inputs.tenant_id,
    projectId: inputs.project_id,
    metadata: {
      trace_id: inputs.trace_id,
      module_id: MODULE_ID,
      jobforge_dry_run: true,
    },
    traceId: inputs.trace_id,
    stableOutput,
  };
}

function buildAnalyzeJobRequest(params: {
  jobType: string;
  tenantId: string;
  projectId: string;
  payload: Record<string, unknown>;
  options: JobOptions & { traceId: string; stableOutput?: boolean };
}): JobRequest {
  return {
    job_type: params.jobType,
    job_id: 'pending',
    tenant_id: params.tenantId,
    project_id: params.projectId,
    requested_at: ensureStableTimestamp(undefined, params.options.stableOutput),
    payload: params.payload,
    priority: params.options.priority ?? 'normal',
    max_retries: params.options.maxRetries ?? 3,
    timeout_seconds: params.options.timeoutSeconds ?? 300,
    metadata: params.options.metadata ?? {},
  };
}

function sortFindings(findings: ReportFinding[]): ReportFinding[] {
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  return [...findings].sort((a, b) => {
    const severityCompare = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
    if (severityCompare !== 0) {
      return severityCompare;
    }
    return a.finding_id.localeCompare(b.finding_id);
  });
}

function buildFindings(params: {
  discrepancies: { subscription_id: string; difference_cents: number; reason: string }[];
  anomalies: { anomaly_id: string; severity: string; anomaly_type: string; description: string }[];
  churnRisks: { risk_id: string; risk_level: string; explanation: string; customer_id: string }[];
}): ReportFinding[] {
  const findings: ReportFinding[] = [];

  for (const discrepancy of params.discrepancies) {
    findings.push({
      finding_id: `recon-${discrepancy.subscription_id}`,
      title: `MRR discrepancy for ${discrepancy.subscription_id}`,
      description: `Detected ${discrepancy.reason} with ${discrepancy.difference_cents} cents difference.`,
      severity: Math.abs(discrepancy.difference_cents) > 1000 ? 'high' : 'medium',
      category: 'reconciliation',
      evidence: [
        `subscription_id: ${discrepancy.subscription_id}`,
        `difference_cents: ${discrepancy.difference_cents}`,
        `reason: ${discrepancy.reason}`,
      ],
      metadata: {},
    });
  }

  for (const anomaly of params.anomalies) {
    findings.push({
      finding_id: anomaly.anomaly_id,
      title: `Anomaly: ${anomaly.anomaly_type.replace(/_/g, ' ')}`,
      description: anomaly.description,
      severity: anomaly.severity as ReportFinding['severity'],
      category: 'anomaly',
      evidence: [
        `anomaly_id: ${anomaly.anomaly_id}`,
        `type: ${anomaly.anomaly_type}`,
      ],
      metadata: {},
    });
  }

  for (const risk of params.churnRisks) {
    findings.push({
      finding_id: risk.risk_id,
      title: `Churn risk: ${risk.customer_id}`,
      description: risk.explanation,
      severity: risk.risk_level as ReportFinding['severity'],
      category: 'churn',
      evidence: [
        `customer_id: ${risk.customer_id}`,
        `risk_level: ${risk.risk_level}`,
      ],
      metadata: {},
    });
  }

  return sortFindings(findings);
}

function buildRecommendations(anomalies: { recommended_action?: string }[], churnRisks: { recommended_actions: string[] }[]): string[] {
  const recommendations = new Set<string>();
  for (const anomaly of anomalies) {
    if (anomaly.recommended_action) {
      recommendations.add(anomaly.recommended_action);
    }
  }
  for (const risk of churnRisks) {
    for (const action of risk.recommended_actions) {
      recommendations.add(action);
    }
  }
  return Array.from(recommendations).sort();
}

function buildReportId(tenantId: string, projectId: string, traceId: string): string {
  const hash = hashCanonical({ tenant_id: tenantId, project_id: projectId, trace_id: traceId });
  return `finops-report-${hash.slice(0, 12)}`;
}

export function analyze(inputs: AnalyzeInputs, options: AnalyzeOptions = {}): {
  reportEnvelope: JobForgeReportEnvelope;
  jobRequestBundle: JobRequestBundle;
} {
  const parsedInputs = AnalyzeInputsSchema.parse(inputs);
  const stableOutput = options.stableOutput ?? false;

  const periodDerived = derivePeriod(parsedInputs.normalized_events ?? parsedInputs.billing_events);
  const periodStart = parsedInputs.period_start ?? periodDerived.periodStart;
  const periodEnd = parsedInputs.period_end ?? periodDerived.periodEnd;

  const ingestionResult = parsedInputs.normalized_events
    ? { events: parsedInputs.normalized_events, stats: { total: parsedInputs.normalized_events.length } }
    : parsedInputs.billing_events
    ? ingestEvents(parsedInputs.billing_events, {
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        skipValidation: false,
      })
    : { events: [], stats: { total: 0 } };

  const normalizedEvents = ingestionResult.events.map((event) =>
    stableOutput
      ? { ...event, normalized_at: STABLE_TIMESTAMP }
      : event
  );

  const ledger = parsedInputs.ledger
    ? parsedInputs.ledger
    : normalizedEvents.length > 0
    ? buildLedger(normalizedEvents, {
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        periodStart,
        periodEnd,
      })
    : undefined;

  const ledgerForReport = ledger && stableOutput
    ? { ...ledger, computed_at: STABLE_TIMESTAMP }
    : ledger;

  const reconcileReport = ledgerForReport
    ? reconcileMrr(ledgerForReport, {
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        periodStart,
        periodEnd,
      })
    : undefined;

  const referenceDate = parsedInputs.reference_date
    ?? parsedInputs.period_end
    ?? periodEnd
    ?? ensureStableTimestamp(undefined, stableOutput);

  const profile = parsedInputs.profile ? getProfile(parsedInputs.profile) : getProfile('jobforge');

  const anomalyResult = ledgerForReport
    ? detectAnomalies(normalizedEvents, ledgerForReport, {
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        referenceDate,
        profile,
      })
    : { anomalies: [], stats: { total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, byType: { missing_invoice: 0, double_charge: 0, refund_spike: 0, dispute_spike: 0, payment_failure_spike: 0, usage_drop: 0, mrr_discrepancy: 0, duplicate_event: 0, out_of_sequence: 0 } } };

  const churnResult = parsedInputs.churn_inputs
    ? assessChurnRisk(parsedInputs.churn_inputs, {
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        referenceDate: parsedInputs.churn_inputs.reference_date,
        profile,
      })
    : { risks: [], stats: { totalAssessed: 0, byLevel: { low: 0, medium: 0, high: 0, critical: 0 }, averageScore: 0 } };

  const jobRequests: JobRequest[] = [];
  if (parsedInputs.job_requests.reconcile) {
    jobRequests.push(
      buildAnalyzeJobRequest({
        jobType: 'autopilot.finops.reconcile',
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        payload: {
          operation: 'reconcile',
          period_start: periodStart,
          period_end: periodEnd,
          events_source: {
            type: 'file',
            path: parsedInputs.job_requests.reconcile.events_path,
            format: 'json',
          },
          output: {
            ledger_path: `./output/ledger-${parsedInputs.tenant_id}-${parsedInputs.project_id}.json`,
            report_path: `./output/recon-${parsedInputs.tenant_id}-${parsedInputs.project_id}.json`,
          },
        },
        options: toJobOptions(parsedInputs, stableOutput),
      })
    );
  }
  if (parsedInputs.job_requests.anomaly_scan) {
    jobRequests.push(
      buildAnalyzeJobRequest({
        jobType: 'autopilot.finops.anomaly_scan',
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        payload: {
          operation: 'anomaly_scan',
          ledger_source: {
            type: 'file',
            path: parsedInputs.job_requests.anomaly_scan.ledger_path,
            format: 'json',
          },
          output: {
            anomalies_path: `./output/anomalies-${parsedInputs.tenant_id}-${parsedInputs.project_id}.json`,
          },
        },
        options: toJobOptions(parsedInputs, stableOutput),
      })
    );
  }
  if (parsedInputs.job_requests.churn_risk) {
    jobRequests.push(
      buildAnalyzeJobRequest({
        jobType: 'autopilot.finops.churn_risk_report',
        tenantId: parsedInputs.tenant_id,
        projectId: parsedInputs.project_id,
        payload: {
          operation: 'churn_risk_report',
          inputs: {
            ledger: {
              type: 'file',
              path: parsedInputs.job_requests.churn_risk.ledger_path,
              format: 'json',
            },
            ...(parsedInputs.job_requests.churn_risk.usage_metrics_path
              ? {
                  usage_metrics: {
                    type: 'file',
                    path: parsedInputs.job_requests.churn_risk.usage_metrics_path,
                    format: 'json',
                  },
                }
              : {}),
            ...(parsedInputs.job_requests.churn_risk.support_tickets_path
              ? {
                  support_tickets: {
                    type: 'file',
                    path: parsedInputs.job_requests.churn_risk.support_tickets_path,
                    format: 'json',
                  },
                }
              : {}),
          },
          output: {
            report_path: `./output/churn-${parsedInputs.tenant_id}-${parsedInputs.project_id}.json`,
          },
        },
        options: {
          ...toJobOptions(parsedInputs, stableOutput),
          timeoutSeconds: 600,
        },
      })
    );
  }

  const jobRequestBundleBase = {
    schema_version: parsedInputs.schema_version,
    module_id: MODULE_ID,
    tenant_id: parsedInputs.tenant_id,
    project_id: parsedInputs.project_id,
    trace_id: parsedInputs.trace_id,
    requests: jobRequests.map((job) => normalizeJobRequest(job, toJobOptions(parsedInputs, stableOutput))).sort((a, b) => a.job_type.localeCompare(b.job_type)),
    metadata: {
      job_count: jobRequests.length,
    },
  };

  const jobRequestCanonical = withCanonicalization(jobRequestBundleBase);
  const jobRequestBundle = {
    ...jobRequestCanonical.payload,
    canonicalization: jobRequestCanonical.canonicalization,
  } as JobRequestBundle;

  const findings = buildFindings({
    discrepancies: reconcileReport?.discrepancies ?? [],
    anomalies: anomalyResult.anomalies,
    churnRisks: churnResult.risks.map((risk) => ({
      risk_id: risk.risk_id,
      risk_level: risk.risk_level,
      explanation: risk.explanation,
      customer_id: risk.customer_id,
    })),
  });

  const recommendations = buildRecommendations(
    anomalyResult.anomalies,
    churnResult.risks
  );

  const reportBase = {
    schema_version: parsedInputs.schema_version,
    module_id: MODULE_ID,
    tenant_id: parsedInputs.tenant_id,
    project_id: parsedInputs.project_id,
    trace_id: parsedInputs.trace_id,
    report_id: buildReportId(parsedInputs.tenant_id, parsedInputs.project_id, parsedInputs.trace_id),
    generated_at: ensureStableTimestamp(undefined, stableOutput),
    report_type: 'finops' as const,
    summary: {
      period_start: periodStart,
      period_end: periodEnd,
      event_count: parsedInputs.billing_events?.length ?? 0,
      normalized_event_count: normalizedEvents.length,
      ledger_customer_count: ledgerForReport ? Object.keys(ledgerForReport.customers).length : 0,
      ledger_mrr_cents: ledgerForReport?.total_mrr_cents ?? 0,
      reconciliation_discrepancies: reconcileReport?.discrepancies.length ?? 0,
      anomaly_count: anomalyResult.anomalies.length,
      churn_risk_count: churnResult.risks.length,
      job_request_count: jobRequests.length,
    },
    findings,
    recommendations,
    metadata: {
      event_envelope_count: parsedInputs.event_envelopes?.length ?? 0,
      run_manifest_count: parsedInputs.run_manifests?.length ?? 0,
    },
  };

  const reportCanonical = withCanonicalization(reportBase);
  const reportEnvelope = {
    ...reportCanonical.payload,
    canonicalization: reportCanonical.canonicalization,
  } as JobForgeReportEnvelope;

  JobRequestBundleSchema.parse(jobRequestBundle);
  JobForgeReportEnvelopeSchema.parse(reportEnvelope);

  return { reportEnvelope, jobRequestBundle };
}

export function validateBundle(bundle: JobRequestBundle): ValidationResult {
  const errors: string[] = [];
  const parsed = JobRequestBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    errors.push(...parsed.error.errors.map((err) => err.message));
    return { success: false, errors };
  }

  if (bundle.schema_version !== DEFAULT_SCHEMA_VERSION) {
    errors.push(`Unsupported schema_version: ${bundle.schema_version}`);
  }

  const allowedJobTypes = new Set([
    'autopilot.finops.reconcile',
    'autopilot.finops.anomaly_scan',
    'autopilot.finops.churn_risk_report',
  ]);

  for (const request of bundle.requests) {
    if (request.tenant_id !== bundle.tenant_id) {
      errors.push(`Request tenant_id mismatch for ${request.job_id}`);
    }
    if (request.project_id !== bundle.project_id) {
      errors.push(`Request project_id mismatch for ${request.job_id}`);
    }
    if (!request.idempotency_key) {
      errors.push(`Missing idempotency_key for ${request.job_id}`);
    }

    const hasAction = ['action', 'action_type', 'action_name'].some((key) =>
      Object.prototype.hasOwnProperty.call(request.payload, key)
    );
    const requiresPolicyToken = (request.metadata as Record<string, unknown> | undefined)?.requires_policy_token === true;
    if (hasAction && !requiresPolicyToken) {
      errors.push(`Action request missing policy token requirement for ${request.job_id}`);
    }

    const status = (request.metadata as Record<string, unknown> | undefined)?.job_type_status;
    if (!allowedJobTypes.has(request.job_type) && status !== 'UNAVAILABLE') {
      errors.push(`Unrecognized job type without UNAVAILABLE status: ${request.job_type}`);
    }
  }

  return { success: errors.length === 0, errors };
}

export function renderReport(reportEnvelope: JobForgeReportEnvelope, format: 'md' | 'markdown' | 'json' = 'md'): string {
  if (format === 'json') {
    return serializeCanonical(reportEnvelope);
  }

  const lines: string[] = [];
  lines.push(`# FinOps Autopilot Report`);
  lines.push('');
  lines.push(`- Tenant: ${reportEnvelope.tenant_id}`);
  lines.push(`- Project: ${reportEnvelope.project_id}`);
  lines.push(`- Trace: ${reportEnvelope.trace_id}`);
  lines.push(`- Generated: ${reportEnvelope.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Period: ${reportEnvelope.summary.period_start ?? 'n/a'} to ${reportEnvelope.summary.period_end ?? 'n/a'}`);
  lines.push(`- Events: ${reportEnvelope.summary.event_count}`);
  lines.push(`- Normalized events: ${reportEnvelope.summary.normalized_event_count}`);
  lines.push(`- Customers: ${reportEnvelope.summary.ledger_customer_count}`);
  lines.push(`- MRR (cents): ${reportEnvelope.summary.ledger_mrr_cents}`);
  lines.push(`- Reconciliation discrepancies: ${reportEnvelope.summary.reconciliation_discrepancies}`);
  lines.push(`- Anomalies: ${reportEnvelope.summary.anomaly_count}`);
  lines.push(`- Churn risks: ${reportEnvelope.summary.churn_risk_count}`);
  lines.push(`- Job requests: ${reportEnvelope.summary.job_request_count}`);
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (reportEnvelope.findings.length === 0) {
    lines.push('- No findings produced.');
  } else {
    for (const finding of reportEnvelope.findings) {
      lines.push(`- [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push(`  - ${finding.description}`);
      if (finding.evidence.length > 0) {
        lines.push(`  - Evidence: ${finding.evidence.join('; ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## Recommendations');
  lines.push('');
  if (reportEnvelope.recommendations.length === 0) {
    lines.push('- No recommendations generated.');
  } else {
    for (const recommendation of reportEnvelope.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  lines.push('');
  lines.push('## Canonicalization');
  lines.push('');
  lines.push(`- Algorithm: ${reportEnvelope.canonicalization.algorithm}`);
  lines.push(`- Format: ${reportEnvelope.canonicalization.canonical_format}`);
  lines.push(`- Hash: ${reportEnvelope.canonicalization.canonical_hash}`);

  return lines.join('\n');
}
