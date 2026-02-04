import { describe, it, expect } from 'vitest';
import {
  createReconcileJob,
  createAnomalyScanJob,
  createChurnRiskJob,
  serializeJobRequest,
} from '../jobforge/index.js';

describe('JobForge', () => {
  describe('job creation', () => {
    it('should create a reconcile job with correct type', () => {
      const job = createReconcileJob(
        '2024-01-01T00:00:00Z',
        '2024-01-31T23:59:59Z',
        './events.json',
        {
          tenantId: 'test-tenant',
          projectId: 'test-project',
        }
      );

      expect(job.job_type).toBe('autopilot.finops.reconcile');
      expect(job.tenant_id).toBe('test-tenant');
      expect(job.project_id).toBe('test-project');
      expect(job.payload.operation).toBe('reconcile');
      expect(job.payload.finops_hooks).toBeDefined();
    });

    it('should create an anomaly scan job', () => {
      const job = createAnomalyScanJob('./ledger.json', {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        priority: 'high',
      });

      expect(job.job_type).toBe('autopilot.finops.anomaly_scan');
      expect(job.priority).toBe('high');
      expect(job.payload.finops_hooks).toBeDefined();
    });

    it('should create a churn risk job with optional inputs', () => {
      const job = createChurnRiskJob('./ledger.json', {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        usageMetricsPath: './usage.json',
        supportTicketsPath: './tickets.json',
      });

      expect(job.job_type).toBe('autopilot.finops.churn_risk_report');
      const inputs = job.payload.inputs as Record<string, unknown>;
      expect(inputs.usage_metrics).toBeDefined();
      expect(inputs.support_tickets).toBeDefined();
      expect(job.payload.finops_hooks).toBeDefined();
    });
  });

  describe('serialization', () => {
    it('should serialize job deterministically', () => {
      const job = createReconcileJob(
        '2024-01-01T00:00:00Z',
        '2024-01-31T23:59:59Z',
        './events.json',
        {
          tenantId: 'test-tenant',
          projectId: 'test-project',
        }
      );

      // Reset timestamp for determinism
      const deterministicJob = {
        ...job,
        requested_at: '2024-01-15T10:00:00Z',
        job_id: 'test-job-id',
      };

      const serialized1 = serializeJobRequest(deterministicJob);
      const serialized2 = serializeJobRequest(deterministicJob);

      expect(serialized1).toBe(serialized2);
    });
  });
});
