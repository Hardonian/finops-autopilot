import { describe, it, expect } from 'vitest';
import {
  buildRunnerMetricsReport,
  validateRunnerMetric,
  createRunnerMetric,
  calculatePercentileLatencies,
  calculateSuccessRate,
  evaluateCostRiskGuards,
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

  it('calculates percentile latencies accurately (p50, p95, p99)', () => {
    const runtimes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const p = calculatePercentileLatencies(runtimes);
    expect(p.p50).toBe(60);
    expect(p.p95).toBe(100);
    expect(p.p99).toBe(100);
  });

  it('calculates success rate reliably', () => {
    const m = createRunnerMetric({
      runner_id: 'test.runner',
      job_type: 'test.job',
      success_count: 95,
      failure_count: 5,
    });
    expect(calculateSuccessRate(m)).toBe(0.95);
  });

  it('evaluates cost-risk guards for high failure rate and excessive retries', () => {
    const riskyMetric = createRunnerMetric({
      runner_id: 'test.risky',
      job_type: 'test.job',
      success_count: 10,
      failure_count: 10, // 50% failure rate
      retry_count: 20, // > success count
      latency_ms_p95: 15000, // > 10s SLA
    });

    const flags = evaluateCostRiskGuards(riskyMetric);
    expect(flags.some((f) => f.includes('HIGH_FAILURE_RATE'))).toBe(true);
    expect(flags.some((f) => f.includes('EXCESSIVE_RETRIES'))).toBe(true);
    expect(flags.some((f) => f.includes('HIGH_LATENCY'))).toBe(true);
  });
});

