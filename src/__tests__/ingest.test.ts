import { describe, it, expect } from 'vitest';
import { ingestEvents } from '../ingest/index.js';
import type { NormalizedEvent } from '../contracts/index.js';

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
});
