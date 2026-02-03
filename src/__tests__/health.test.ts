import { describe, expect, it } from 'vitest';
import {
  getHealthStatus,
  getCapabilityMetadata,
  isSupportedJobType,
  getRetryPolicy,
  MODULE_ID,
  MODULE_VERSION,
  SCHEMA_VERSION,
} from '../health/index.js';

describe('Health and capabilities', () => {
  describe('getHealthStatus', () => {
    it('returns healthy status with all checks passing', () => {
      const health = getHealthStatus();
      expect(health.status).toBe('healthy');
      expect(health.module_id).toBe(MODULE_ID);
      expect(health.module_version).toBe(MODULE_VERSION);
      expect(health.checks.contracts).toBe(true);
      expect(health.checks.schemas).toBe(true);
      expect(health.checks.profiles).toBe(true);
    });

    it('includes required capabilities', () => {
      const health = getHealthStatus();
      expect(health.capabilities).toContain('billing_ingest');
      expect(health.capabilities).toContain('mrr_reconcile');
      expect(health.capabilities).toContain('anomaly_detect');
      expect(health.capabilities).toContain('churn_assess');
      expect(health.capabilities).toContain('jobforge_emit');
    });

    it('includes ISO timestamp', () => {
      const health = getHealthStatus();
      expect(health.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('getCapabilityMetadata', () => {
    it('returns module identification', () => {
      const meta = getCapabilityMetadata();
      expect(meta.module_id).toBe(MODULE_ID);
      expect(meta.module_version).toBe(MODULE_VERSION);
      expect(meta.schema_version).toBe(SCHEMA_VERSION);
    });

    it('defines all job types with correct properties', () => {
      const meta = getCapabilityMetadata();
      expect(meta.job_types).toHaveLength(4);

      const reconcile = meta.job_types.find(j => j.job_type === 'autopilot.finops.reconcile');
      expect(reconcile).toBeDefined();
      expect(reconcile?.idempotent).toBe(true);
      expect(reconcile?.retryable).toBe(true);
      expect(reconcile?.max_retries).toBe(3);
      expect(reconcile?.required_context).toContain('tenant_id');

      const costSnapshot = meta.job_types.find(j => j.job_type === 'autopilot.finops.cost_snapshot');
      expect(costSnapshot).toBeDefined();
      expect(costSnapshot?.deterministic).toBe(true);
      expect(costSnapshot?.cacheable).toBe(true);
      expect(costSnapshot?.cache_invalidation_rule).toBeDefined();
    });

    it('includes input and output formats', () => {
      const meta = getCapabilityMetadata();
      expect(meta.input_formats).toContain('json');
      expect(meta.output_formats).toContain('json');
      expect(meta.output_formats).toContain('markdown');
    });

    it('includes key features', () => {
      const meta = getCapabilityMetadata();
      expect(meta.features).toContain('deterministic_output');
      expect(meta.features).toContain('canonical_hashing');
      expect(meta.features).toContain('multi_tenant');
      expect(meta.features).toContain('jobforge_compatible');
    });

    it('includes DLQ semantics', () => {
      const meta = getCapabilityMetadata();
      expect(meta.dlq_semantics.enabled).toBe(true);
      expect(meta.dlq_semantics.max_attempts).toBe(3);
      expect(meta.dlq_semantics.backoff_strategy).toBe('exponential');
      expect(meta.dlq_semantics.retryable_errors).toContain('io_error');
      expect(meta.dlq_semantics.non_retryable_errors).toContain('validation_error');
    });
  });

  describe('isSupportedJobType', () => {
    it('returns true for supported job types', () => {
      expect(isSupportedJobType('autopilot.finops.reconcile')).toBe(true);
      expect(isSupportedJobType('autopilot.finops.anomaly_scan')).toBe(true);
      expect(isSupportedJobType('autopilot.finops.churn_risk_report')).toBe(true);
      expect(isSupportedJobType('autopilot.finops.cost_snapshot')).toBe(true);
    });

    it('returns false for unsupported job types', () => {
      expect(isSupportedJobType('autopilot.finops.invalid')).toBe(false);
      expect(isSupportedJobType('autopilot.other.job')).toBe(false);
      expect(isSupportedJobType('')).toBe(false);
    });
  });

  describe('getRetryPolicy', () => {
    it('returns non-retryable for validation errors', () => {
      const policy = getRetryPolicy('validation_error');
      expect(policy.retryable).toBe(false);
      expect(policy.max_attempts).toBe(0);
    });

    it('returns retryable for IO errors', () => {
      const policy = getRetryPolicy('io_error');
      expect(policy.retryable).toBe(true);
      expect(policy.max_attempts).toBe(3);
      expect(policy.backoff_seconds).toBe(1);
    });

    it('returns default policy for unknown errors', () => {
      const policy = getRetryPolicy('unknown_error');
      expect(policy.retryable).toBe(true);
      expect(policy.max_attempts).toBe(1);
    });

    it('uses provided DLQ configuration', () => {
      const customDlq = {
        enabled: true,
        max_attempts: 5,
        backoff_strategy: 'linear' as const,
        backoff_initial_seconds: 2,
        backoff_max_seconds: 30,
        retryable_errors: ['custom_error'],
        non_retryable_errors: ['fatal_error'],
      };
      
      const policy = getRetryPolicy('custom_error', customDlq);
      expect(policy.retryable).toBe(true);
      expect(policy.max_attempts).toBe(5);
      expect(policy.backoff_seconds).toBe(2);
    });
  });

  describe('Module constants', () => {
    it('has correct module ID', () => {
      expect(MODULE_ID).toBe('finops');
    });

    it('has semver version', () => {
      expect(MODULE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('has schema version', () => {
      expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
