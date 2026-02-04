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
