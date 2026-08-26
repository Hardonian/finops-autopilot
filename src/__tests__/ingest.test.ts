import { describe, it, expect } from 'vitest';
import { ingestEvents } from '../ingest/index.js';

describe('Ingest', () => {
  describe('determinism', () => {
    it('should produce identical output for identical input', () => {
      const rawEvents = [
        {
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
          plan_id: 'plan_pro',
        },
        {
          event_id: 'evt_2',
          event_type: 'invoice_paid',
          timestamp: '2024-01-16T10:00:00Z',
          customer_id: 'cus_1',
          invoice_id: 'inv_1',
          amount_cents: 5000,
          currency: 'USD',
        },
      ];

      const result1 = ingestEvents(rawEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
      });

      const result2 = ingestEvents(rawEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
      });

      expect(result1.events.length).toBe(result2.events.length);
      expect(result1.stats.total).toBe(result2.stats.total);
      
      // Source hashes should be identical
      result1.events.forEach((event1, i) => {
        const event2 = result2.events[i];
        expect(event1.source_hash).toBe(event2.source_hash);
        expect(event1.event_id).toBe(event2.event_id);
      });
    });

    it('should sort events deterministically', () => {
      const rawEvents = [
        {
          event_id: 'evt_b',
          event_type: 'invoice_paid',
          timestamp: '2024-01-16T10:00:00Z',
          customer_id: 'cus_1',
          amount_cents: 5000,
          currency: 'USD',
        },
        {
          event_id: 'evt_a',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          amount_cents: 5000,
          currency: 'USD',
        },
      ];

      const result = ingestEvents(rawEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
      });

      // Should be sorted by timestamp
      expect(result.events[0].event_id).toBe('evt_a');
      expect(result.events[1].event_id).toBe('evt_b');
    });
  });

  describe('validation', () => {
    it('should report validation errors for invalid events', () => {
      const rawEvents = [
        {
          event_id: 'evt_1',
          // Missing required fields
        },
      ];

      const result = ingestEvents(rawEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
      });

      expect(result.stats.valid).toBe(0);
      expect(result.stats.invalid).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    it('should compute stable hashes', () => {
      const rawEvents = [
        {
          event_id: 'evt_1',
          event_type: 'subscription_created',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_1',
          subscription_id: 'sub_1',
          amount_cents: 5000,
          currency: 'USD',
        },
      ];

      const result = ingestEvents(rawEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
      });

      expect(result.events[0].source_hash).toBeDefined();
      expect(result.events[0].source_hash.length).toBe(64); // SHA-256 hex
    });
  });

  describe('multi-format ingestion (CSV, JSONL, Providers)', () => {
    it('should parse RFC 4180 CSV with autodetected comma delimiter', () => {
      const csv = `event_id,event_type,timestamp,customer_id,subscription_id,amount_cents,currency
evt_csv_1,subscription_created,2024-01-15T10:00:00Z,cus_100,sub_100,9900,USD
evt_csv_2,invoice_paid,2024-01-16T10:00:00Z,cus_100,sub_100,9900,USD`;

      const result = ingestEvents(csv, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'csv',
      });

      expect(result.stats.valid).toBe(2);
      expect(result.events[0].event_id).toBe('evt_csv_1');
      expect(result.events[0].amount_cents).toBe(9900);
      expect(result.events[1].event_type).toBe('invoice_paid');
    });

    it('should parse semicolon-delimited CSV', () => {
      const csv = `event_id;event_type;timestamp;customer_id;amount_cents;currency
evt_semi_1;subscription_created;2024-01-15T10:00:00Z;cus_200;4900;EUR`;

      const result = ingestEvents(csv, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'csv',
      });

      expect(result.stats.valid).toBe(1);
      expect(result.events[0].customer_id).toBe('cus_200');
      expect(result.events[0].currency).toBe('EUR');
    });

    it('should parse JSONL billing records', () => {
      const jsonl = `{"event_id":"evt_jl_1","event_type":"subscription_created","timestamp":"2024-01-15T10:00:00Z","customer_id":"cus_jl","amount_cents":15000,"currency":"USD"}
{"event_id":"evt_jl_2","event_type":"invoice_paid","timestamp":"2024-01-16T10:00:00Z","customer_id":"cus_jl","amount_cents":15000,"currency":"USD"}`;

      const result = ingestEvents(jsonl, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'jsonl',
      });

      expect(result.stats.valid).toBe(2);
      expect(result.events[0].amount_cents).toBe(15000);
    });

    it('should normalize Stripe webhook events', () => {
      const stripeEvents = [
        {
          id: 'evt_stripe_charge_1',
          type: 'charge.succeeded',
          created: 1705312800,
          data: {
            object: {
              id: 'ch_1',
              customer: 'cus_stripe_1',
              amount: 4200,
              currency: 'usd',
            },
          },
        },
        {
          id: 'evt_stripe_sub_1',
          type: 'customer.subscription.created',
          created: 1705312900,
          data: {
            object: {
              id: 'sub_stripe_1',
              customer: 'cus_stripe_1',
              plan: { id: 'plan_scale', amount: 4200 },
            },
          },
        },
      ];

      const result = ingestEvents(stripeEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'stripe',
      });

      expect(result.stats.valid).toBe(2);
      expect(result.events[0].event_type).toBe('payment_succeeded');
      expect(result.events[0].amount_cents).toBe(4200);
      expect(result.events[1].event_type).toBe('subscription_created');
      expect(result.events[1].plan_id).toBe('plan_scale');
    });

    it('should normalize AWS CUR billing exports', () => {
      const awsCur = [
        {
          'identity/LineItemId': 'cur_item_1',
          'lineItem/ProductCode': 'AmazonEC2',
          'lineItem/UsageStartDate': '2024-01-15T00:00:00Z',
          'lineItem/UsageAccountId': '123456789012',
          'lineItem/UnblendedCost': '124.50',
          'lineItem/CurrencyCode': 'USD',
          'pricing/publicOnDemandCost': '124.50',
        },
      ];

      const result = ingestEvents(awsCur, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'aws_cur',
      });

      expect(result.stats.valid).toBe(1);
      expect(result.events[0].amount_cents).toBe(12450);
      expect(result.events[0].customer_id).toBe('123456789012');
      expect(result.events[0].event_type).toBe('usage_recorded');
    });

    it('should normalize GCP Cloud Billing export records', () => {
      const gcpBilling = [
        {
          billing_account_id: '012345-678901-ABCDEF',
          service: { id: 'compute.googleapis.com', description: 'Compute Engine' },
          sku: { id: 'sku-1', description: 'N1 Standard 4' },
          usage_start_time: '2024-01-15T00:00:00Z',
          project: { id: 'gcp-prod-app' },
          cost: 85.25,
          currency: 'USD',
        },
      ];

      const result = ingestEvents(gcpBilling, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        format: 'gcp_billing',
      });

      expect(result.stats.valid).toBe(1);
      expect(result.events[0].amount_cents).toBe(8525);
      expect(result.events[0].customer_id).toBe('gcp-prod-app');
      expect(result.events[0].event_type).toBe('usage_recorded');
    });

    it('should deduplicate repeated events within time window', () => {
      const duplicatedEvents = [
        {
          event_id: 'evt_dup_1',
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_dup',
          amount_cents: 2000,
          currency: 'USD',
        },
        {
          event_id: 'evt_dup_1', // Duplicate ID
          event_type: 'invoice_paid',
          timestamp: '2024-01-15T10:00:00Z',
          customer_id: 'cus_dup',
          amount_cents: 2000,
          currency: 'USD',
        },
      ];

      const result = ingestEvents(duplicatedEvents, {
        tenantId: 'test-tenant',
        projectId: 'test-project',
        dedupWindowSeconds: 300,
      });

      expect(result.stats.total).toBe(2);
      expect(result.stats.valid).toBe(1);
      expect(result.stats.duplicates).toBe(1);
    });
  });
});
