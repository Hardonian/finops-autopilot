import { describe, it, expect } from 'vitest';
import { buildLedger, reconcileMrr } from '../reconcile/index.js';
import type { NormalizedEvent } from '../contracts/index.js';

describe('Reconcile', () => {
  describe('determinism', () => {
    it('should produce identical ledger for identical events', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
          plan_id: 'plan_pro',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
      ];

      const options = {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const ledger1 = buildLedger(events, options);
      const ledger2 = buildLedger(events, options);

expect(ledger1.total_mrr_cents).toBe(ledger2.total_mrr_cents);
      expect(ledger1.total_customers).toBe(ledger2.total_customers);
      expect(ledger1.active_subscriptions).toBe(ledger2.active_subscriptions);
      expect(ledger1.event_count).toBe(ledger2.event_count);
      // Note: computed_at timestamps will differ, which is expected
    });

    it('should produce identical report hash for identical data', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
          plan_id: 'plan_pro',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
      ];

      const options = {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const ledger1 = buildLedger(events, options);
      const ledger2 = buildLedger(events, options);

      const report1 = reconcileMrr(ledger1, options);
      const report2 = reconcileMrr(ledger2, options);

      expect(report1.report_hash).toBe(report2.report_hash);
    });
  });

  describe('mrr calculation', () => {
    it('should calculate MRR correctly for active subscriptions', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
          plan_id: 'plan_pro',
          period_start: '2024-01-15T00:00:00Z',
          period_end: '2024-02-15T00:00:00Z',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
      ];

      const options = {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const ledger = buildLedger(events, options);

      expect(ledger.total_mrr_cents).toBe(5000);
      expect(ledger.total_customers).toBe(1);
      expect(ledger.active_subscriptions).toBe(1);
    });

    it('should not include canceled subscriptions in MRR', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-01T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
          plan_id: 'plan_pro',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-01T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_2',
          event_type: 'subscription_cancelled',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash2',
          validation_errors: [],
        },
      ];

      const options = {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      };

      const ledger = buildLedger(events, options);

      expect(ledger.active_subscriptions).toBe(0);
    });
  });
});
