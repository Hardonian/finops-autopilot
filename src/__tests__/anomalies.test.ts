import { describe, it, expect } from 'vitest';
import { detectAnomalies } from '../anomalies/index.js';
import type { NormalizedEvent, LedgerState } from '../contracts/index.js';

describe('Anomalies', () => {
  describe('correctness', () => {
    it('should detect duplicate events', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          invoice_id: 'inv_1',
          amount_cents: 5000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1', // Same ID
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:02:00Z', // Within 5 min window
          customer_id: 'cus_1',
          invoice_id: 'inv_1',
          amount_cents: 5000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:02:00Z',
          source_hash: 'hash2',
          validation_errors: [],
        },
      ];

      const ledger: LedgerState = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-01-15T10:00:00Z',
        customers: {},
        total_mrr_cents: 0,
        total_customers: 0,
        active_subscriptions: 0,
        event_count: 2,
        version: '1.0.0',
      };

      const result = detectAnomalies(events, ledger, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-15T10:00:00Z',
      });

      const duplicateAnomalies = result.anomalies.filter(
        (a) => a.anomaly_type === 'duplicate_event'
      );
      expect(duplicateAnomalies.length).toBeGreaterThan(0);
    });

    it('should detect double charges', () => {
      const events: NormalizedEvent[] = [
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_1',
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          invoice_id: 'inv_1',
          amount_cents: 5000,
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:00:00Z',
          source_hash: 'hash1',
          validation_errors: [],
        },
        {
          tenant_id: 'test-tenant',
          project_id: 'test-project',
          event_id: 'evt_2',
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:05:00Z',
          customer_id: 'cus_1',
          invoice_id: 'inv_1', // Same invoice
          amount_cents: 5000,  // Same amount
          currency: 'USD',
          metadata: {},
          raw_payload: {},
          normalized_at: '2024-01-15T10:05:00Z',
          source_hash: 'hash2',
          validation_errors: [],
        },
      ];

      const ledger: LedgerState = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-01-15T10:00:00Z',
        customers: {
          cus_1: {
            customer_id: 'cus_1',
            tenant_id: 'test-tenant',
            project_id: 'test-project',
            subscriptions: [],
            total_mrr_cents: 5000,
            total_paid_cents: 10000,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 0,
            updated_at: '2024-01-15T10:00:00Z',
          },
        },
        total_mrr_cents: 5000,
        total_customers: 1,
        active_subscriptions: 0,
        event_count: 2,
        version: '1.0.0',
      };

      const result = detectAnomalies(events, ledger, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-15T10:00:00Z',
      });

      const doubleChargeAnomalies = result.anomalies.filter(
        (a) => a.anomaly_type === 'double_charge'
      );
      expect(doubleChargeAnomalies.length).toBeGreaterThan(0);
    });

    it('should detect statistical outlier spikes with high Z-scores', () => {
      const regularPayments: NormalizedEvent[] = Array.from({ length: 20 }, (_, i) => ({
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        event_id: `evt_reg_${i}`,
        event_type: 'invoice_paid',
        timestamp: `2024-01-${(i + 1).toString().padStart(2, '0')}T10:00:00Z`,
        customer_id: `cus_${i}`,
        amount_cents: 5000,
        currency: 'USD',
        metadata: {},
        raw_payload: {},
        normalized_at: '2024-01-15T10:00:00Z',
        source_hash: `hash_${i}`,
        validation_errors: [],
      }));

      // Outlier spike of $50,000 compared to $50 mean
      regularPayments.push({
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        event_id: 'evt_spike',
        event_type: 'invoice_paid',
        timestamp: '2024-01-25T10:00:00Z',
        customer_id: 'cus_spike',
        amount_cents: 5000000,
        currency: 'USD',
        metadata: {},
        raw_payload: {},
        normalized_at: '2024-01-25T10:00:00Z',
        source_hash: 'hash_spike',
        validation_errors: [],
      });

      const ledger: LedgerState = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-01-25T10:00:00Z',
        customers: {},
        total_mrr_cents: 100000,
        total_customers: 21,
        active_subscriptions: 21,
        event_count: regularPayments.length,
        version: '1.0.0',
      };

      const result = detectAnomalies(regularPayments, ledger, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-25T10:00:00Z',
      });

      const spikes = result.anomalies.filter((a) => a.metadata && 'z_score' in a.metadata);
      expect(spikes.length).toBeGreaterThan(0);
      expect(spikes[0].customer_id).toBe('cus_spike');
    });

    it('should detect ghost subscriptions with long inactivity', () => {
      const ledger: LedgerState = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-05-01T10:00:00Z',
        customers: {
          cus_ghost: {
            customer_id: 'cus_ghost',
            tenant_id: 'test-tenant',
            project_id: 'test-project',
            subscriptions: [
              {
                subscription_id: 'sub_ghost_1',
                customer_id: 'cus_ghost',
                plan_id: 'plan_enterprise',
                status: 'active',
                current_period_start: '2024-01-01T00:00:00Z',
                current_period_end: '2024-02-01T00:00:00Z',
                mrr_cents: 20000,
                currency: 'USD',
                created_at: '2024-01-01T00:00:00Z',
                cancel_at_period_end: false,
              },
            ],
            total_mrr_cents: 20000,
            total_paid_cents: 20000,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 0,
            last_invoice_at: '2024-01-01T00:00:00Z', // 120 days inactive
            updated_at: '2024-01-01T00:00:00Z',
          },
        },
        total_mrr_cents: 20000,
        total_customers: 1,
        active_subscriptions: 1,
        event_count: 0,
        version: '1.0.0',
      };

      const result = detectAnomalies([], ledger, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-05-01T10:00:00Z',
      });

      const ghosts = result.anomalies.filter((a) => a.metadata && 'days_inactive' in a.metadata);
      expect(ghosts.length).toBeGreaterThan(0);
      expect(ghosts[0].subscription_id).toBe('sub_ghost_1');
    });
  });
});
