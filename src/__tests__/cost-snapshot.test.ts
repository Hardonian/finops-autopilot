import { describe, it, expect } from 'vitest';
import {
  generateCostSnapshot,
  shouldInvalidateCache,
} from '../cost-snapshot/index.js';
import type { CostSnapshotInput, BillingEvent } from '../contracts/index.js';

// Golden snapshot test data - must be stable across runs
const STABLE_TENANT = 'test-tenant';
const STABLE_PROJECT = 'test-project';
const STABLE_PERIOD_START = '2024-01-01T00:00:00Z';
const STABLE_PERIOD_END = '2024-01-31T23:59:59Z';

const goldenBillingEvents: BillingEvent[] = [
  {
    tenant_id: STABLE_TENANT,
    project_id: STABLE_PROJECT,
    event_id: 'evt_sub_001',
    event_type: 'subscription_created',
    timestamp: '2024-01-05T10:00:00Z',
    customer_id: 'cus_001',
    subscription_id: 'sub_001',
    amount_cents: 5000,
    currency: 'USD',
    plan_id: 'plan_pro',
    metadata: {},
    raw_payload: { id: 'evt_sub_001' },
  },
  {
    tenant_id: STABLE_TENANT,
    project_id: STABLE_PROJECT,
    event_id: 'evt_usage_001',
    event_type: 'usage_recorded',
    timestamp: '2024-01-15T14:30:00Z',
    customer_id: 'cus_001',
    subscription_id: 'sub_001',
    amount_cents: 1500,
    currency: 'USD',
    metadata: {},
    raw_payload: { id: 'evt_usage_001' },
  },
  {
    tenant_id: STABLE_TENANT,
    project_id: STABLE_PROJECT,
    event_id: 'evt_refund_001',
    event_type: 'invoice_refunded',
    timestamp: '2024-01-20T09:00:00Z',
    customer_id: 'cus_002',
    subscription_id: 'sub_002',
    amount_cents: -2500,
    currency: 'USD',
    invoice_id: 'inv_001',
    metadata: {},
    raw_payload: { id: 'evt_refund_001' },
  },
];

// Helper to create valid input with defaults
function createInput(partial: Partial<CostSnapshotInput> & { tenant_id: string; project_id: string; period_start: string; period_end: string }): CostSnapshotInput {
  return {
    include_breakdown: true,
    include_forecast: false,
    ...partial,
  } as CostSnapshotInput;
}

describe('Cost Snapshot (DD CAPABILITY: finops.cost_snapshot)', () => {
  describe('Deterministic output', () => {
    it('produces identical output for identical input (golden snapshot)', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
        include_breakdown: true,
        include_forecast: false,
      });

      const result1 = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      const result2 = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      // Both should succeed
      expect('report' in result1).toBe(true);
      expect('report' in result2).toBe(true);

      if ('report' in result1 && 'report' in result2) {
        // Report IDs should be identical
        expect(result1.report.report_id).toBe(result2.report.report_id);

        // Total cost should be identical
        expect(result1.report.total_cost_cents).toBe(result2.report.total_cost_cents);

        // Cache keys should be identical
        expect(result1.cacheKey).toBe(result2.cacheKey);

        // Metadata should match
        expect(result1.report.metadata.event_count).toBe(result2.report.metadata.event_count);
        expect(result1.report.metadata.customer_count).toBe(result2.report.metadata.customer_count);
      }
    });

    it('generates stable report_id for same input', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const result1 = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      const result2 = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result1).toBe(true);
      expect('report' in result2).toBe(true);

      if ('report' in result1 && 'report' in result2) {
        // Report ID must be identical for identical inputs
        expect(result1.report.report_id).toBe(result2.report.report_id);
        expect(result1.report.report_id).toMatch(/^cost-snapshot-[a-f0-9]{16}$/);
      }
    });

    it('generates different report_id for different input', () => {
      const input1 = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const input2 = createInput({
        tenant_id: STABLE_TENANT,
        project_id: 'different-project',
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const result1 = generateCostSnapshot(input1, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      const result2 = generateCostSnapshot(input2, {
        tenantId: STABLE_TENANT,
        projectId: 'different-project',
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result1).toBe(true);
      expect('report' in result2).toBe(true);

      if ('report' in result1 && 'report' in result2) {
        // Different projects should produce different report IDs
        expect(result1.report.report_id).not.toBe(result2.report.report_id);
      }
    });
  });

  describe('Cache invalidation rules', () => {
    it('should not invalidate historical data (> 24h old)', () => {
      const oldPeriodEnd = '2023-01-01T00:00:00Z'; // Over 1 year old
      const shouldInvalidate = shouldInvalidateCache(oldPeriodEnd);
      expect(shouldInvalidate).toBe(false);
    });

    it('should invalidate recent data (< 24h old)', () => {
      const recentPeriodEnd = new Date();
      recentPeriodEnd.setMinutes(recentPeriodEnd.getMinutes() - 30);
      const shouldInvalidate = shouldInvalidateCache(recentPeriodEnd.toISOString());
      expect(shouldInvalidate).toBe(true);
    });

    it('should invalidate on explicit flag', () => {
      const oldPeriodEnd = '2023-01-01T00:00:00Z';
      const shouldInvalidate = shouldInvalidateCache(oldPeriodEnd, true);
      expect(shouldInvalidate).toBe(true);
    });
  });

  describe('Evidence strength validation (truthcore)', () => {
    it('refuses on empty events', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: [],
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('refusal' in result).toBe(true);
      if ('refusal' in result) {
        expect(result.refusal).toContain('INSUFFICIENT_DATA');
      }
    });

    it('refuses on currency mismatch', () => {
      const mixedCurrencyEvents: BillingEvent[] = [
        {
          tenant_id: STABLE_TENANT,
          project_id: STABLE_PROJECT,
          event_id: 'evt_001',
          event_type: 'subscription_created',
          timestamp: '2024-01-05T10:00:00Z',
          customer_id: 'cus_001',
          amount_cents: 5000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
        },
        {
          tenant_id: STABLE_TENANT,
          project_id: STABLE_PROJECT,
          event_id: 'evt_002',
          event_type: 'subscription_created',
          timestamp: '2024-01-06T10:00:00Z',
          customer_id: 'cus_002',
          amount_cents: 3000,
          currency: 'EUR', // Different currency
          metadata: {},
          raw_payload: {},
        },
      ];

      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: mixedCurrencyEvents,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('refusal' in result).toBe(true);
      if ('refusal' in result) {
        expect(result.refusal).toContain('CURRENCY_MISMATCH');
      }
    });

    it('refuses on invalid period', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: '2024-01-31T00:00:00Z',
        period_end: '2024-01-01T00:00:00Z', // End before start
        billing_events: goldenBillingEvents,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: '2024-01-31T00:00:00Z',
        periodEnd: '2024-01-01T00:00:00Z',
        stableOutput: true,
      });

      expect('refusal' in result).toBe(true);
      if ('refusal' in result) {
        expect(result.refusal).toContain('INVALID_PERIOD');
      }
    });
  });

  describe('Cost breakdown accuracy', () => {
    it('calculates correct total from events', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result).toBe(true);

      if ('report' in result) {
        // 5000 + 1500 - 2500 = 4000
        expect(result.report.total_cost_cents).toBe(4000);
        expect(result.report.currency).toBe('USD');
      }
    });

    it('categorizes line items correctly', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
        include_breakdown: true,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result).toBe(true);

      if ('report' in result) {
        const { breakdown } = result.report;
        expect(breakdown.by_category.subscription).toBe(5000);
        expect(breakdown.by_category.usage).toBe(1500);
        expect(breakdown.by_category.refund).toBe(-2500);
        expect(breakdown.line_items).toHaveLength(3);
      }
    });

    it('respects include_breakdown flag', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
        include_breakdown: false,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result).toBe(true);

      if ('report' in result) {
        expect(result.report.breakdown.by_customer).toBeUndefined();
        expect(result.report.breakdown.by_subscription).toBeUndefined();
        expect(result.report.breakdown.line_items).toHaveLength(3); // Always included
      }
    });
  });

  describe('Metadata and caching', () => {
    it('includes deterministic and cacheable flags', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result).toBe(true);

      if ('report' in result) {
        expect(result.report.metadata.deterministic).toBe(true);
        expect(result.report.metadata.cacheable).toBe(true);
        expect(result.report.metadata.cache_key).toBeDefined();
        expect(result.report.metadata.cache_key).toHaveLength(64); // SHA-256 hash
      }
    });

    it('counts unique customers and subscriptions', () => {
      const input = createInput({
        tenant_id: STABLE_TENANT,
        project_id: STABLE_PROJECT,
        period_start: STABLE_PERIOD_START,
        period_end: STABLE_PERIOD_END,
        billing_events: goldenBillingEvents,
      });

      const result = generateCostSnapshot(input, {
        tenantId: STABLE_TENANT,
        projectId: STABLE_PROJECT,
        periodStart: STABLE_PERIOD_START,
        periodEnd: STABLE_PERIOD_END,
        stableOutput: true,
      });

      expect('report' in result).toBe(true);

      if ('report' in result) {
        expect(result.report.metadata.customer_count).toBe(2); // cus_001 and cus_002
        expect(result.report.metadata.subscription_count).toBe(2); // sub_001 and sub_002
        expect(result.report.metadata.event_count).toBe(3);
      }
    });
  });
});
