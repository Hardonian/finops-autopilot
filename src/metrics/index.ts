import {
  RunnerMetricSchema,
  RunnerMetricsReportSchema,
  type RunnerMetric,
  type RunnerMetricsReport,
} from '../contracts/index.js';

const DEFAULT_MODULE_ID = 'finops';
const DEFAULT_SCHEMA_VERSION = '1.0.0';

export interface RunnerMetricsOptions {
  moduleId?: string;
  schemaVersion?: string;
  generatedAt?: string;
}

/**
 * Calculate p50, p95, p99 latency percentiles from measured runtimes
 */
export function calculatePercentileLatencies(latenciesMs: number[]): { p50: number; p95: number; p99: number } {
  if (latenciesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const getP = (pct: number): number => {
    const idx = Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1);
    return Math.round(sorted[idx]);
  };

  return {
    p50: getP(50),
    p95: getP(95),
    p99: getP(99),
  };
}

/**
 * Calculate runner execution success rate (0.0 to 1.0)
 */
export function calculateSuccessRate(metric: RunnerMetric): number {
  const total = metric.success_count + metric.failure_count;
  if (total === 0) return 1.0;
  return Math.round((metric.success_count / total) * 1000) / 1000;
}

/**
 * Evaluate cost-risk guards against runner execution metrics
 */
export function evaluateCostRiskGuards(metric: RunnerMetric): string[] {
  const flags: string[] = [];

  const totalRuns = metric.success_count + metric.failure_count;
  if (totalRuns > 0) {
    const failureRate = metric.failure_count / totalRuns;
    if (failureRate > 0.15) {
      flags.push(`HIGH_FAILURE_RATE: ${(failureRate * 100).toFixed(1)}% failures exceeds 15% threshold`);
    }
  }

  if (metric.retry_count > metric.success_count && metric.retry_count > 5) {
    flags.push(`EXCESSIVE_RETRIES: ${metric.retry_count} retries exceeds success count ${metric.success_count}`);
  }

  if (metric.latency_ms_p95 > 10000) {
    flags.push(`HIGH_LATENCY: p95 latency ${metric.latency_ms_p95}ms exceeds 10s SLA`);
  }

  return flags;
}

/**
 * Create a validated runner metric entry
 */
export function createRunnerMetric(
  params: {
    runner_id: string;
    job_type: string;
    window_start?: string;
    window_end?: string;
    captured_at?: string;
    success_count?: number;
    failure_count?: number;
    retry_count?: number;
    idempotent_replay_count?: number;
    input_records?: number;
    output_records?: number;
    latency_ms_p50?: number;
    latency_ms_p95?: number;
    cost_risk_flags?: string[];
    metadata?: Record<string, unknown>;
  }
): RunnerMetric {
  const now = new Date().toISOString();
  const metric: RunnerMetric = {
    runner_id: params.runner_id,
    job_type: params.job_type,
    window_start: params.window_start ?? now,
    window_end: params.window_end ?? now,
    captured_at: params.captured_at ?? now,
    success_count: params.success_count ?? 0,
    failure_count: params.failure_count ?? 0,
    retry_count: params.retry_count ?? 0,
    idempotent_replay_count: params.idempotent_replay_count ?? 0,
    input_records: params.input_records ?? 0,
    output_records: params.output_records ?? 0,
    latency_ms_p50: params.latency_ms_p50 ?? 0,
    latency_ms_p95: params.latency_ms_p95 ?? 0,
    cost_risk_flags: params.cost_risk_flags ?? [],
    metadata: params.metadata ?? {},
  };

  if (metric.cost_risk_flags.length === 0) {
    metric.cost_risk_flags = evaluateCostRiskGuards(metric);
  }

  return RunnerMetricSchema.parse(metric);
}

export function buildRunnerMetricsReport(
  metrics: RunnerMetric[],
  options: RunnerMetricsOptions = {}
): RunnerMetricsReport {
  const report: RunnerMetricsReport = {
    module_id: options.moduleId ?? DEFAULT_MODULE_ID,
    schema_version: options.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    metrics,
  };

  RunnerMetricsReportSchema.parse(report);
  return report;
}

export function validateRunnerMetric(metric: RunnerMetric): RunnerMetric {
  return RunnerMetricSchema.parse(metric);
}

export function serializeRunnerMetricsReport(report: RunnerMetricsReport): string {
  return JSON.stringify(report, null, 2);
}

export type { RunnerMetric, RunnerMetricsReport };

