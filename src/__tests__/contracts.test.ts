import { describe, it, expect } from 'vitest';
import {
  BillingEventSchema,
  LedgerStateSchema,
} from '../contracts/index.js';

describe('Contracts', () => {
  describe('BillingEventSchema', () => {
    it('should validate a valid billing event', () => {
      const event = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        event_id: 'evt_123',
        event_type: 'subscription_created',
        timestamp: '2024-01-15T10:00:00Z',
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
        amount_cents: 5000,
        currency: 'USD',
        plan_id: 'plan_pro',
        metadata: {},
        raw_payload: { id: 'evt_123' },
      };

      const result = BillingEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should reject invalid tenant_id format', () => {
      const event = {
        tenant_id: 'Invalid Tenant',
        project_id: 'test-project',
        event_id: 'evt_123',
        event_type: 'subscription_created',
        timestamp: '2024-01-15T10:00:00Z',
        customer_id: 'cus_123',
        metadata: {},
        raw_payload: {},
      };

      const result = BillingEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should reject invalid currency format', () => {
      const event = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        event_id: 'evt_123',
        event_type: 'subscription_created',
        timestamp: '2024-01-15T10:00:00Z',
        customer_id: 'cus_123',
        currency: 'US',
        metadata: {},
        raw_payload: {},
      };

      const result = BillingEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });

  describe('LedgerStateSchema', () => {
    it('should validate a ledger state', () => {
      const ledger = {
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        computed_at: '2024-01-15T10:00:00Z',
        customers: {
          cus_123: {
            customer_id: 'cus_123',
            tenant_id: 'test-tenant',
            project_id: 'test-project',
            subscriptions: [],
            total_mrr_cents: 5000,
            total_paid_cents: 5000,
            total_refunded_cents: 0,
            total_disputed_cents: 0,
            payment_failure_count_30d: 0,
            updated_at: '2024-01-15T10:00:00Z',
          },
        },
        total_mrr_cents: 5000,
        total_customers: 1,
        active_subscriptions: 0,
        event_count: 10,
        version: '1.0.0',
      };

      const result = LedgerStateSchema.safeParse(ledger);
      expect(result.success).toBe(true);
    });
  });
});
