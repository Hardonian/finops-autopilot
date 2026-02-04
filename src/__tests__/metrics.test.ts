import { describe, it, expect } from 'vitest';
import {
  buildRunnerMetricsReport,
  validateRunnerMetric,
} from '../metrics/index.js';

describe('Runner metrics', () => {
  it('builds a valid metrics report', () => {
    const metric = validateRunnerMetric({
      runner_id: 'finops.reconcile',
      job_type: 'autopilot.finops.reconcile',
      window_start: '2024-01-01T00:00:00.000Z',
      window_end: '2024-01-31T23:59:59.999Z',
      captured_at: '2024-02-01T00:00:00.000Z',
      success_count: 10,
      failure_count: 1,
      retry_count: 2,
      idempotent_replay_count: 3,
      input_records: 1200,
      output_records: 4,
      latency_ms_p50: 250,
      latency_ms_p95: 1200,
      cost_risk_flags: [],
      metadata: { region: 'us-east-1' },
    });

    const report = buildRunnerMetricsReport([metric], {
      moduleId: 'finops',
      schemaVersion: '1.0.0',
      generatedAt: '2024-02-01T00:00:00.000Z',
    });

    expect(report.metrics).toHaveLength(1);
    expect(report.metrics[0]?.runner_id).toBe('finops.reconcile');
  });
});
