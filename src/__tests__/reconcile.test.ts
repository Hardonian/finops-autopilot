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

  describe('MRR Waterfall and Proration calculations', () => {
    it('should compute MRR waterfall with movements (new, expansion, contraction, churn)', () => {
      const events: NormalizedEvent[] = [
        // New customer sub
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_wf_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-05T10:00:00Z',
          customer_id: 'cus_new',
          subscription_id: 'sub_new',
          amount_cents: 10000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-05T10:00:00Z',
          source_hash: 'h1',
          validation_errors: [],
        },
        // Expanding customer sub
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_wf_2',
          event_type: 'subscription_created',
          timestamp: '2023-12-01T10:00:00Z', // Before period start
          customer_id: 'cus_exp',
          subscription_id: 'sub_exp',
          amount_cents: 5000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2023-12-01T10:00:00Z',
          source_hash: 'h2',
          validation_errors: [],
        },
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_wf_3',
          event_type: 'subscription_updated',
          timestamp: '2024-01-10T10:00:00Z',
          customer_id: 'cus_exp',
          subscription_id: 'sub_exp',
          amount_cents: 8000, // +3000 expansion
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-10T10:00:00Z',
          source_hash: 'h3',
          validation_errors: [],
        },
        // Churning customer
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_wf_4',
          event_type: 'subscription_created',
          timestamp: '2023-12-01T10:00:00Z',
          customer_id: 'cus_churn',
          subscription_id: 'sub_churn',
          amount_cents: 4000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2023-12-01T10:00:00Z',
          source_hash: 'h4',
          validation_errors: [],
        },
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_wf_5',
          event_type: 'subscription_cancelled',
          timestamp: '2024-01-20T10:00:00Z',
          customer_id: 'cus_churn',
          subscription_id: 'sub_churn',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-20T10:00:00Z',
          source_hash: 'h5',
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
      const report = reconcileMrr(ledger, options, events);

      expect(report.waterfall).toBeDefined();
      expect(report.waterfall?.starting_mrr_cents).toBe(9000); // 5000 + 4000
      expect(report.waterfall?.new_mrr_cents).toBe(10000);
      expect(report.waterfall?.expansion_mrr_cents).toBe(3000);
      expect(report.waterfall?.churn_mrr_cents).toBe(4000);
      expect(report.waterfall?.ending_mrr_cents).toBe(18000); // 9000 + 10000 + 3000 - 4000
      expect(report.waterfall?.net_new_mrr_cents).toBe(9000);
    });

    it('should generate remediation playbook for reconciliation discrepancies', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_disc_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-01T10:00:00Z',
          customer_id: 'cus_unpaid',
          subscription_id: 'sub_unpaid',
          amount_cents: 50000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-01T10:00:00Z',
          source_hash: 'h_unpaid',
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
      const report = reconcileMrr(ledger, options, events);

      expect(report.is_balanced).toBe(false);
      expect(report.discrepancies.length).toBeGreaterThan(0);
      expect(report.remediation_playbook).toBeDefined();
      expect(report.remediation_playbook?.length).toBeGreaterThan(0);
    });
  });
});
