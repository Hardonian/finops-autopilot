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
  });
});
