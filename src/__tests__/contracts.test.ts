import { describe, it, expect } from 'vitest';
import {
  BillingEventSchema,
  LedgerStateSchema,
  ModuleManifestSchema,
  EvidencePacketSchema,
  StructuredLogEventSchema,
  ErrorEnvelopeSchema,
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

  describe('ModuleManifestSchema', () => {
    it('should validate a valid manifest', () => {
      const manifest = {
        module_id: 'finops',
        version: '0.1.0',
        schema_version: '1.0.0',
        description: 'FinOps autopilot module',
        entrypoints: [{ name: 'finops', type: 'cli', path: './dist/cli.js' }],
        schemas: ['BillingEventSchema', 'LedgerStateSchema'],
        capabilities: ['billing_ingest', 'mrr_reconcile'],
      };

      const result = ModuleManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it('should reject manifest with empty module_id', () => {
      const manifest = {
        module_id: '',
        version: '0.1.0',
        schema_version: '1.0.0',
        description: 'test',
        entrypoints: [],
        schemas: [],
        capabilities: [],
      };

      const result = ModuleManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it('should reject invalid entrypoint type', () => {
      const manifest = {
        module_id: 'finops',
        version: '0.1.0',
        schema_version: '1.0.0',
        description: 'test',
        entrypoints: [{ name: 'finops', type: 'invalid', path: './dist/cli.js' }],
        schemas: [],
        capabilities: [],
      };

      const result = ModuleManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });
  });

  describe('EvidencePacketSchema', () => {
    it('should validate a valid evidence packet', () => {
      const packet = {
        packet_id: 'pkt-1',
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        created_at: '2024-01-15T10:00:00Z',
        source_module: 'finops',
        event_type: 'anomaly_detected',
        severity: 'high',
        summary: 'Double charge detected for customer cus_123',
        evidence: [
          { label: 'invoice_amount', value: 5000, source: 'ledger' },
          { label: 'duplicate_id', value: 'inv_456' },
        ],
        related_entities: [
          { entity_type: 'customer', entity_id: 'cus_123' },
          { entity_type: 'invoice', entity_id: 'inv_456' },
        ],
        hash: 'abc123def456',
      };

      const result = EvidencePacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });

    it('should reject invalid severity', () => {
      const packet = {
        packet_id: 'pkt-1',
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        created_at: '2024-01-15T10:00:00Z',
        source_module: 'finops',
        event_type: 'test',
        severity: 'unknown',
        summary: 'test',
        evidence: [],
        hash: 'abc',
      };

      const result = EvidencePacketSchema.safeParse(packet);
      expect(result.success).toBe(false);
    });
  });

  describe('StructuredLogEventSchema', () => {
    it('should validate a valid log event', () => {
      const event = {
        timestamp: '2024-01-15T10:00:00Z',
        level: 'info',
        module: 'finops',
        action: 'ingest',
        tenant_id: 'test-tenant',
        project_id: 'test-project',
        message: 'Ingested 42 billing events',
        data: { event_count: 42, valid: 40, invalid: 2 },
        duration_ms: 150,
      };

      const result = StructuredLogEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should validate a log event with error', () => {
      const event = {
        timestamp: '2024-01-15T10:00:00Z',
        level: 'error',
        module: 'finops',
        action: 'reconcile',
        message: 'Reconciliation failed',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid ledger state',
          stack: 'Error: Invalid ledger state\n    at reconcile...',
        },
      };

      const result = StructuredLogEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should reject invalid log level', () => {
      const event = {
        timestamp: '2024-01-15T10:00:00Z',
        level: 'trace',
        module: 'finops',
        action: 'test',
        message: 'test',
      };

      const result = StructuredLogEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });

  describe('ErrorEnvelopeSchema', () => {
    it('should validate a valid error envelope', () => {
      const envelope = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid billing event format',
          details: [
            { field: 'tenant_id', constraint: 'required', message: 'tenant_id is required' },
            { message: 'raw_payload must be an object' },
          ],
          source_module: 'finops',
          timestamp: '2024-01-15T10:00:00Z',
          trace_id: 'trace-123',
          retryable: false,
        },
      };

      const result = ErrorEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
    });

    it('should validate retryable error', () => {
      const envelope = {
        error: {
          code: 'IO_ERROR',
          message: 'Failed to read billing export',
          details: [],
          source_module: 'finops',
          timestamp: '2024-01-15T10:00:00Z',
          retryable: true,
        },
      };

      const result = ErrorEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.error.retryable).toBe(true);
      }
    });

    it('should reject unknown error code', () => {
      const envelope = {
        error: {
          code: 'UNKNOWN_CODE',
          message: 'test',
          details: [],
          source_module: 'finops',
          timestamp: '2024-01-15T10:00:00Z',
          retryable: false,
        },
      };

      const result = ErrorEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(false);
    });
  });
});
