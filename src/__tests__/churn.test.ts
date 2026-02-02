import { describe, it, expect } from 'vitest';
import { assessChurnRisk } from '../churn/index.js';
import type { ChurnInputs, LedgerState } from '../contracts/index.js';

describe('Churn', () => {
  describe('correctness', () => {
    it('should identify high risk from payment failures', () => {
      const ledger: LedgerState = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-01-15T10:00:00Z',
        customers: {
          cus_1: {
            customer_id: 'cus_1',
            tenant_id: 'test-tenant',
            project_id: 'test-project',
            subscriptions: [
{
                subscription_id: 'sub_1',
                customer_id: 'cus_1',
                plan_id: 'plan_pro',
                status: 'active',
                current_period_start: '2024-01-01T00:00:00Z',
                current_period_end: '2024-02-01T00:00:00Z',
                mrr_cents: 5000,
                currency: 'USD',
                created_at: '2024-01-01T00:00:00Z',
                cancel_at_period_end: false,
              },
            ],
            total_mrr_cents: 5000,
            total_paid_cents: 0,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 5,
            updated_at: '2024-01-15T10:00:00Z',
          },
        },
        total_mrr_cents: 5000,
        total_customers: 1,
        active_subscriptions: 1,
        event_count: 1,
        version: '1.0.0',
      };

      const inputs: ChurnInputs = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        ledger,
        usage_metrics: [],
        support_tickets: [],
        plan_downgrades: [],
        reference_date: '2024-01-15T10:00:00Z',
      };

      const result = assessChurnRisk(inputs, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-15T10:00:00Z',
      });

      expect(result.risks.length).toBe(1);
      expect(result.risks[0].customer_id).toBe('cus_1');
      expect(result.risks[0].risk_score).toBeGreaterThan(0);
      
      const hasPaymentFailureSignal = result.risks[0].contributing_signals.some(
        (s) => s.signal_type === 'payment_failures'
      );
      expect(hasPaymentFailureSignal).toBe(true);
    });

    it('should explain the risk factors', () => {
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
            total_mrr_cents: 0,
            total_paid_cents: 0,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 0,
            updated_at: '2024-01-15T10:00:00Z',
          },
        },
        total_mrr_cents: 0,
        total_customers: 1,
        active_subscriptions: 0,
        event_count: 0,
        version: '1.0.0',
      };

      const inputs: ChurnInputs = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        ledger,
        usage_metrics: [],
        support_tickets: [],
        plan_downgrades: [],
        reference_date: '2024-01-15T10:00:00Z',
      };

      const result = assessChurnRisk(inputs, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-15T10:00:00Z',
      });

      expect(result.risks[0].explanation).toContain('cus_1');
    });
  });

  describe('redaction', () => {
    it('should not include sensitive data in raw_values', () => {
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
            total_paid_cents: 0,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 3,
            updated_at: '2024-01-15T10:00:00Z',
          },
        },
        total_mrr_cents: 5000,
        total_customers: 1,
        active_subscriptions: 0,
        event_count: 1,
        version: '1.0.0',
      };

      const inputs: ChurnInputs = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        ledger,
        usage_metrics: [],
        support_tickets: [],
        plan_downgrades: [],
        reference_date: '2024-01-15T10:00:00Z',
      };

      const result = assessChurnRisk(inputs, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        referenceDate: '2024-01-15T10:00:00Z',
      });

      // Verify output can be serialized without sensitive data leakage
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('token');
    });
  });
});
