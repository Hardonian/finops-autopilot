/**
 * Core domain contracts and Zod schemas for finops-autopilot
 * 
 * All entities are multi-tenant safe with required tenant_id + project_id
 * All timestamps are ISO 8601 strings for deterministic serialization
 */

import { z } from 'zod';

// ============================================================================
// Primitive Types
// ============================================================================

export const TenantIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);
export const ProjectIdSchema = z.string().min(1).regex(/^[a-z0-9-_]+$/);

export type TenantId = z.infer<typeof TenantIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const EventIdSchema = z.string().min(1);
export const CustomerIdSchema = z.string().min(1);
export const SubscriptionIdSchema = z.string().min(1);
export const InvoiceIdSchema = z.string().min(1);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const TimestampSchema = z.string().datetime();

// ============================================================================
// Billing Event Types
// ============================================================================

export const BillingEventTypeSchema = z.enum([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'invoice_paid',
  'invoice_failed',
  'invoice_refunded',
  'invoice_disputed',
  'usage_recorded',
  'payment_succeeded',
  'payment_failed',
  'refund_issued',
  'dispute_created',
  'dispute_won',
  'dispute_lost',
]);

export const BillingEventSchema = z.object({
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  event_id: EventIdSchema,
  event_type: BillingEventTypeSchema,
  timestamp: TimestampSchema,
  customer_id: CustomerIdSchema,
  subscription_id: SubscriptionIdSchema.optional(),
  invoice_id: InvoiceIdSchema.optional(),
  amount_cents: z.number().int().optional(),
  currency: CurrencySchema.optional(),
  plan_id: z.string().optional(),
  period_start: TimestampSchema.optional(),
  period_end: TimestampSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
  raw_payload: z.record(z.unknown()),
});

export type BillingEvent = z.infer<typeof BillingEventSchema>;
export type BillingEventType = z.infer<typeof BillingEventTypeSchema>;

// ============================================================================
// Normalized Event (canonical schema after ingestion)
// ============================================================================

export const NormalizedEventSchema = BillingEventSchema.extend({
  normalized_at: TimestampSchema,
  source_hash: z.string(),
  validation_errors: z.array(z.string()).default([]),
});

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// ============================================================================
// Ledger State
// ============================================================================

export const SubscriptionStateSchema = z.object({
  subscription_id: SubscriptionIdSchema,
  customer_id: CustomerIdSchema,
  plan_id: z.string(),
  status: z.enum(['active', 'canceled', 'past_due', 'unpaid', 'paused']),
  current_period_start: TimestampSchema,
  current_period_end: TimestampSchema,
  mrr_cents: z.number().int().min(0),
  currency: CurrencySchema,
  created_at: TimestampSchema,
  canceled_at: TimestampSchema.optional(),
  cancel_at_period_end: z.boolean().default(false),
});

export const CustomerLedgerSchema = z.object({
  customer_id: CustomerIdSchema,
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  subscriptions: z.array(SubscriptionStateSchema),
  total_mrr_cents: z.number().int().min(0),
  total_paid_cents: z.number().int().min(0),
  total_refunded_cents: z.number().int().min(0),
  total_disputed_cents: z.number().int().min(0),
  last_invoice_at: TimestampSchema.optional(),
  last_payment_at: TimestampSchema.optional(),
  payment_failure_count_30d: z.number().int().min(0).default(0),
  updated_at: TimestampSchema,
});

export const LedgerStateSchema = z.object({
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  computed_at: TimestampSchema,
  customers: z.record(CustomerIdSchema, CustomerLedgerSchema),
  total_mrr_cents: z.number().int().min(0),
  total_customers: z.number().int().min(0),
  active_subscriptions: z.number().int().min(0),
  event_count: z.number().int().min(0),
  version: z.string().default('1.0.0'),
});

export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;
export type CustomerLedger = z.infer<typeof CustomerLedgerSchema>;
export type LedgerState = z.infer<typeof LedgerStateSchema>;

// ============================================================================
// Reconciliation Report
// ============================================================================

export const MrrDiscrepancySchema = z.object({
  subscription_id: SubscriptionIdSchema,
  customer_id: CustomerIdSchema,
  expected_mrr_cents: z.number().int(),
  observed_mrr_cents: z.number().int(),
  difference_cents: z.number().int(),
  reason: z.enum([
    'missing_invoice',
    'double_charge',
    'incorrect_plan',
    'currency_mismatch',
    'period_mismatch',
    'other',
  ]),
  events_involved: z.array(EventIdSchema),
});

export const ReconReportSchema = z.object({
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  report_id: z.string(),
  generated_at: TimestampSchema,
  period_start: TimestampSchema,
  period_end: TimestampSchema,
  total_expected_mrr_cents: z.number().int(),
  total_observed_mrr_cents: z.number().int(),
  total_difference_cents: z.number().int(),
  discrepancies: z.array(MrrDiscrepancySchema),
  missing_events: z.array(BillingEventSchema),
  unmatched_observations: z.array(z.record(z.unknown())),
  is_balanced: z.boolean(),
  report_hash: z.string(),
  version: z.string().default('1.0.0'),
});

export type MrrDiscrepancy = z.infer<typeof MrrDiscrepancySchema>;
export type ReconReport = z.infer<typeof ReconReportSchema>;

// ============================================================================
// Anomaly Detection
// ============================================================================

export const AnomalyTypeSchema = z.enum([
  'missing_invoice',
  'double_charge',
  'refund_spike',
  'dispute_spike',
  'payment_failure_spike',
  'usage_drop',
  'mrr_discrepancy',
  'duplicate_event',
  'out_of_sequence',
]);

export const AnomalySeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const AnomalySchema = z.object({
  anomaly_id: z.string(),
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  anomaly_type: AnomalyTypeSchema,
  severity: AnomalySeveritySchema,
  detected_at: TimestampSchema,
  customer_id: CustomerIdSchema.optional(),
  subscription_id: SubscriptionIdSchema.optional(),
  description: z.string(),
  affected_events: z.array(EventIdSchema),
  expected_value: z.number().optional(),
  observed_value: z.number().optional(),
  difference: z.number().optional(),
  confidence: z.number().min(0).max(1),
  recommended_action: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type AnomalyType = z.infer<typeof AnomalyTypeSchema>;
export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;
export type Anomaly = z.infer<typeof AnomalySchema>;

// ============================================================================
// Churn Risk
// ============================================================================

export const ChurnSignalSchema = z.object({
  signal_type: z.enum([
    'payment_failures',
    'usage_drop',
    'support_tickets',
    'plan_downgrade',
    'no_recent_login',
    'dispute_filed',
    'refund_requested',
  ]),
  weight: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  raw_values: z.record(z.unknown()).optional(),
});

export const ChurnRiskSchema = z.object({
  risk_id: z.string(),
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  customer_id: CustomerIdSchema,
  calculated_at: TimestampSchema,
  risk_score: z.number().min(0).max(100),
  risk_level: z.enum(['low', 'medium', 'high', 'critical']),
  contributing_signals: z.array(ChurnSignalSchema),
  explanation: z.string(),
  recommended_actions: z.array(z.string()),
  supporting_data: z.record(z.unknown()).optional(),
  version: z.string().default('1.0.0'),
});

export type ChurnSignal = z.infer<typeof ChurnSignalSchema>;
export type ChurnRisk = z.infer<typeof ChurnRiskSchema>;

// ============================================================================
// JobForge Integration
// ============================================================================

export const JobTypeSchema = z.enum([
  'autopilot.finops.reconcile',
  'autopilot.finops.anomaly_scan',
  'autopilot.finops.churn_risk_report',
]);

export const JobRequestSchema = z.object({
  job_type: JobTypeSchema,
  job_id: z.string(),
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  requested_at: TimestampSchema,
  payload: z.record(z.unknown()),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  max_retries: z.number().int().min(0).default(3),
  timeout_seconds: z.number().int().min(0).default(300),
  metadata: z.record(z.unknown()).default({}),
});

export type JobType = z.infer<typeof JobTypeSchema>;
export type JobRequest = z.infer<typeof JobRequestSchema>;

// ============================================================================
// Profile Configuration
// ============================================================================

export const AnomalyThresholdSchema = z.object({
  refund_spike_threshold_cents: z.number().int().min(0).default(100000),
  refund_spike_threshold_pct: z.number().min(0).max(100).default(10),
  dispute_spike_threshold: z.number().int().min(0).default(5),
  payment_failure_spike_threshold: z.number().min(0).max(1).default(0.25),
  duplicate_event_window_seconds: z.number().int().min(0).default(300),
  usage_drop_threshold_pct: z.number().min(0).max(100).default(50),
});

export const ChurnThresholdSchema = z.object({
  payment_failure_weight: z.number().min(0).max(1).default(0.3),
  usage_drop_weight: z.number().min(0).max(1).default(0.25),
  support_ticket_weight: z.number().min(0).max(1).default(0.2),
  plan_downgrade_weight: z.number().min(0).max(1).default(0.15),
  inactivity_weight: z.number().min(0).max(1).default(0.1),
  risk_score_low_threshold: z.number().min(0).max(100).default(30),
  risk_score_medium_threshold: z.number().min(0).max(100).default(50),
  risk_score_high_threshold: z.number().min(0).max(100).default(75),
});

export const ProfileSchema = z.object({
  profile_id: z.string(),
  tenant_id: TenantIdSchema.optional(),
  project_id: ProjectIdSchema.optional(),
  name: z.string(),
  description: z.string().optional(),
  plan_ids: z.array(z.string()).optional(),
  anomaly_thresholds: AnomalyThresholdSchema.default({}),
  churn_thresholds: ChurnThresholdSchema.default({}),
  alert_routing: z.object({
    channels: z.array(z.enum(['email', 'slack', 'webhook', 'pagerduty'])),
    severity_filter: z.array(AnomalySeveritySchema).default(['high', 'critical']),
  }).default({ channels: [] }),
  redact_sensitive_data: z.boolean().default(true),
  version: z.string().default('1.0.0'),
});

export type AnomalyThreshold = z.infer<typeof AnomalyThresholdSchema>;
export type ChurnThreshold = z.infer<typeof ChurnThresholdSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

// ============================================================================
// Churn Input (external data)
// ============================================================================

export const UsageMetricsSchema = z.object({
  customer_id: CustomerIdSchema,
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  metric_name: z.string(),
  current_value: z.number(),
  previous_value: z.number(),
  period_days: z.number().int().positive(),
  measured_at: TimestampSchema,
});

export const SupportTicketSchema = z.object({
  ticket_id: z.string(),
  customer_id: CustomerIdSchema,
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  created_at: TimestampSchema,
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
  category: z.string(),
});

export const ChurnInputsSchema = z.object({
  tenant_id: TenantIdSchema,
  project_id: ProjectIdSchema,
  ledger: LedgerStateSchema,
  usage_metrics: z.array(UsageMetricsSchema).default([]),
  support_tickets: z.array(SupportTicketSchema).default([]),
  plan_downgrades: z.array(z.object({
    customer_id: CustomerIdSchema,
    from_plan: z.string(),
    to_plan: z.string(),
    changed_at: TimestampSchema,
  })).default([]),
  reference_date: TimestampSchema,
});

export type UsageMetrics = z.infer<typeof UsageMetricsSchema>;
export type SupportTicket = z.infer<typeof SupportTicketSchema>;
export type ChurnInputs = z.infer<typeof ChurnInputsSchema>;
