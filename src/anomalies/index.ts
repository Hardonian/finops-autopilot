/**
 * Anomaly Detection
 * 
 * Detects billing anomalies including missing events, double charges,
 * refund spikes, dispute spikes, and other operational irregularities.
 * 
 * Performance optimizations:
 * - O(n) duplicate detection using time-window bucketing (was O(n²))
 * - Single-pass event categorization for multiple detection types
 * - Pre-computed lookup maps to avoid repeated iterations
 * - Batched anomaly validation at boundary
 */

import type {
  NormalizedEvent,
  LedgerState,
  Anomaly,
  AnomalyType,
  AnomalySeverity,
  Profile,
  AnomalyThreshold,
} from '../contracts/index.js';
import { AnomalySchema } from '../contracts/index.js';
import { createHash } from 'crypto';

export interface AnomalyOptions {
  tenantId: string;
  projectId: string;
  referenceDate: string;
  profile?: Profile;
}

export interface AnomalyResult {
  anomalies: Anomaly[];
  stats: {
    total: number;
    bySeverity: Record<AnomalySeverity, number>;
    byType: Record<AnomalyType, number>;
  };
}

// Hash cache for anomaly ID generation
const anomalyHashCache = new Map<string, string>();

/**
 * Detect anomalies in billing data
 * 
 * Performance: O(n) where n = number of events
 * Each detection pass is linear, with pre-computed indices
 */
export function detectAnomalies(
  events: NormalizedEvent[],
  ledger: LedgerState,
  options: AnomalyOptions
): AnomalyResult {
  const thresholds = options.profile?.anomaly_thresholds ?? getDefaultThresholds();
  const anomalies: Anomaly[] = [];

  // Pre-compute event indices in single pass for O(1) lookups
  // This avoids O(n²) nested loops in detection functions
  const eventIndices = buildEventIndices(events);

  // Run all detection algorithms with shared context
  const detectionContext: DetectionContext = {
    events,
    ledger,
    options,
    thresholds,
    eventIndices,
  };

  // Collect anomalies from all detectors
  anomalies.push(...detectDuplicateEventsOptimized(detectionContext));
  anomalies.push(...detectMissingInvoicesOptimized(detectionContext));
  anomalies.push(...detectDoubleChargesOptimized(detectionContext));
  anomalies.push(...detectRefundSpikesOptimized(detectionContext));
  anomalies.push(...detectDisputeSpikesOptimized(detectionContext));
  anomalies.push(...detectPaymentFailureSpikesOptimized(detectionContext));
  anomalies.push(...detectOutOfSequenceEventsOptimized(detectionContext));

  // Batch validate anomalies at boundary (not during detection)
  const validatedAnomalies = batchValidateAnomalies(anomalies);

  // Calculate statistics in single pass
  const bySeverity: Record<AnomalySeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  const byType: Record<AnomalyType, number> = {
    missing_invoice: 0,
    double_charge: 0,
    refund_spike: 0,
    dispute_spike: 0,
    payment_failure_spike: 0,
    usage_drop: 0,
    mrr_discrepancy: 0,
    duplicate_event: 0,
    out_of_sequence: 0,
  };

  for (const anomaly of validatedAnomalies) {
    bySeverity[anomaly.severity]++;
    byType[anomaly.anomaly_type]++;
  }

  return {
    anomalies: validatedAnomalies,
    stats: {
      total: validatedAnomalies.length,
      bySeverity,
      byType,
    },
  };
}

// Context object shared across detection functions
interface DetectionContext {
  events: NormalizedEvent[];
  ledger: LedgerState;
  options: AnomalyOptions;
  thresholds: AnomalyThreshold;
  eventIndices: EventIndices;
}

// Pre-computed event indices for O(1) lookups
interface EventIndices {
  bySubscription: Map<string, NormalizedEvent[]>;
  byInvoice: Map<string, NormalizedEvent[]>;
  byCustomer: Map<string, NormalizedEvent[]>;
  byEventId: Map<string, NormalizedEvent[]>;
  refundEvents: NormalizedEvent[];
  disputeEvents: NormalizedEvent[];
  paymentEvents: NormalizedEvent[];
}

/**
 * Build lookup indices for events in single O(n) pass
 */
function buildEventIndices(events: NormalizedEvent[]): EventIndices {
  const bySubscription = new Map<string, NormalizedEvent[]>();
  const byInvoice = new Map<string, NormalizedEvent[]>();
  const byCustomer = new Map<string, NormalizedEvent[]>();
  const byEventId = new Map<string, NormalizedEvent[]>();
  const refundEvents: NormalizedEvent[] = [];
  const disputeEvents: NormalizedEvent[] = [];
  const paymentEvents: NormalizedEvent[] = [];

  for (const event of events) {
    // Index by event_id for duplicate detection
    const eventList = byEventId.get(event.event_id) ?? [];
    eventList.push(event);
    byEventId.set(event.event_id, eventList);

    // Index by subscription
    if (event.subscription_id) {
      const subList = bySubscription.get(event.subscription_id) ?? [];
      subList.push(event);
      bySubscription.set(event.subscription_id, subList);
    }

    // Index by invoice
    if (event.invoice_id) {
      const invList = byInvoice.get(event.invoice_id) ?? [];
      invList.push(event);
      byInvoice.set(event.invoice_id, invList);
    }

    // Index by customer
    const custList = byCustomer.get(event.customer_id) ?? [];
    custList.push(event);
    byCustomer.set(event.customer_id, custList);

    // Categorize by event type for batch processing
    if (event.event_type === 'invoice_refunded' || event.event_type === 'refund_issued') {
      refundEvents.push(event);
    } else if (event.event_type === 'invoice_disputed' || event.event_type === 'dispute_created' || event.event_type === 'dispute_lost') {
      disputeEvents.push(event);
    } else if (event.event_type === 'invoice_paid' || event.event_type === 'payment_succeeded') {
      paymentEvents.push(event);
    }
  }

  return {
    bySubscription,
    byInvoice,
    byCustomer,
    byEventId,
    refundEvents,
    disputeEvents,
    paymentEvents,
  };
}

/**
 * Batch validate anomalies at boundary
 * More efficient than validating each anomaly individually
 */
function batchValidateAnomalies(anomalies: Anomaly[]): Anomaly[] {
  const validated: Anomaly[] = [];
  
  for (const anomaly of anomalies) {
    const result = AnomalySchema.safeParse(anomaly);
    if (result.success) {
      validated.push(result.data);
    }
    // Skip invalid anomalies silently - they shouldn't happen with proper typing
  }
  
  return validated;
}

function getDefaultThresholds(): AnomalyThreshold {
  return {
    refund_spike_threshold_cents: 100000,
    refund_spike_threshold_pct: 10,
    dispute_spike_threshold: 5,
    payment_failure_spike_threshold: 0.25,
    duplicate_event_window_seconds: 300,
    usage_drop_threshold_pct: 50,
  };
}

/**
 * Generate anomaly ID with memoization
 * Uses cache key: type:tenantId:projectId:reference
 */
function generateAnomalyId(
  type: AnomalyType,
  tenantId: string,
  projectId: string,
  reference: string
): string {
  const cacheKey = `${type}:${tenantId}:${projectId}:${reference}`;
  
  const cached = anomalyHashCache.get(cacheKey);
  if (cached) return cached;
  
  const hash = createHash('sha256')
    .update(cacheKey)
    .digest('hex')
    .slice(0, 16);
  const id = `anomaly-${type}-${hash}`;
  
  // Cache for potential reuse (bounded by unique combinations)
  anomalyHashCache.set(cacheKey, id);
  
  return id;
}

/**
 * Detect duplicate events using time-window bucketing - O(n) complexity
 * 
 * Instead of O(n²) nested loops, we:
 * 1. Group events by event_id (already indexed)
 * 2. For each group, sort by timestamp (small groups, typically 1-3 items)
 * 3. Compare adjacent events for time window violations
 */
function detectDuplicateEventsOptimized(ctx: DetectionContext): Anomaly[] {
  const { options, thresholds, eventIndices } = ctx;
  const anomalies: Anomaly[] = [];
  const windowMs = thresholds.duplicate_event_window_seconds * 1000;

  for (const [eventId, eventList] of eventIndices.byEventId) {
    // Skip if only one event with this ID
    if (eventList.length < 2) continue;

    // Sort events by timestamp for this event_id group
    // This is O(k log k) where k = events per ID (typically small)
    const sorted = [...eventList].sort((a, b) => 
      a.timestamp.localeCompare(b.timestamp)
    );

    // Compare adjacent pairs - O(k) for this group
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const previous = sorted[i - 1];

      const timeDiff = new Date(current.timestamp).getTime() - 
                       new Date(previous.timestamp).getTime();

      if (timeDiff < windowMs) {
        const anomaly: Anomaly = {
          anomaly_id: generateAnomalyId('duplicate_event', options.tenantId, options.projectId, eventId),
          tenant_id: options.tenantId,
          project_id: options.projectId,
          anomaly_type: 'duplicate_event',
          severity: 'high',
          detected_at: options.referenceDate,
          customer_id: current.customer_id,
          description: `Duplicate event detected: ${eventId} (${current.event_type}) within ${Math.round(timeDiff / 1000)}s`,
          affected_events: [current.event_id, previous.event_id],
          expected_value: 1,
          observed_value: i + 1,
          difference: i,
          confidence: 1.0,
          recommended_action: 'Review event ingestion pipeline for duplicate handling',
          metadata: {},
        };

        anomalies.push(anomaly);
        break; // Only report once per duplicate chain
      }
    }
  }

  return anomalies;
}

/**
 * Detect missing invoices using pre-computed subscription index
 */
function detectMissingInvoicesOptimized(ctx: DetectionContext): Anomaly[] {
  const { ledger, options } = ctx;
  const anomalies: Anomaly[] = [];

  for (const customer of Object.values(ledger.customers)) {
    for (const subscription of customer.subscriptions) {
      if (subscription.status !== 'active') continue;

      const subEvents = ctx.eventIndices.bySubscription.get(subscription.subscription_id) ?? [];
      
      // Fast path: check for invoice events without full filter
      let hasInvoiceEvent = false;
      for (const event of subEvents) {
        if (event.event_type === 'invoice_paid' || event.event_type === 'invoice_failed') {
          hasInvoiceEvent = true;
          break;
        }
      }

      if (!hasInvoiceEvent && subscription.mrr_cents > 0) {
        const anomaly: Anomaly = {
          anomaly_id: generateAnomalyId('missing_invoice', options.tenantId, options.projectId, subscription.subscription_id),
          tenant_id: options.tenantId,
          project_id: options.projectId,
          anomaly_type: 'missing_invoice',
          severity: 'medium',
          detected_at: options.referenceDate,
          customer_id: customer.customer_id,
          subscription_id: subscription.subscription_id,
          description: `Active subscription ${subscription.subscription_id} has no invoice events in period`,
          affected_events: subEvents.map((e) => e.event_id),
          expected_value: subscription.mrr_cents,
          observed_value: 0,
          difference: subscription.mrr_cents,
          confidence: 0.8,
          recommended_action: 'Verify invoice generation and payment collection for this subscription',
          metadata: {},
        };

        anomalies.push(anomaly);
      }
    }
  }

  return anomalies;
}

/**
 * Detect double charges using pre-computed invoice index
 */
function detectDoubleChargesOptimized(ctx: DetectionContext): Anomaly[] {
  const { options, eventIndices } = ctx;
  const anomalies: Anomaly[] = [];

  for (const [invoiceId, payments] of eventIndices.byInvoice) {
    if (payments.length < 2) continue;

    // Filter to payment events
    const paymentEvents = payments.filter(e => 
      e.event_type === 'invoice_paid' || e.event_type === 'payment_succeeded'
    );

    if (paymentEvents.length < 2) continue;

    const firstAmount = paymentEvents[0].amount_cents ?? 0;
    
    // Check for same amount (double charge indicator)
    let sameAmountCount = 0;
    let totalAmount = 0;
    
    for (const payment of paymentEvents) {
      totalAmount += payment.amount_cents ?? 0;
      if (payment.amount_cents === firstAmount) {
        sameAmountCount++;
      }
    }

    if (sameAmountCount > 1) {
      const anomaly: Anomaly = {
        anomaly_id: generateAnomalyId('double_charge', options.tenantId, options.projectId, invoiceId),
        tenant_id: options.tenantId,
        project_id: options.projectId,
        anomaly_type: 'double_charge',
        severity: 'critical',
        detected_at: options.referenceDate,
        customer_id: paymentEvents[0].customer_id,
        description: `Potential double charge: ${sameAmountCount} payments of ${firstAmount} cents for invoice ${invoiceId}`,
        affected_events: paymentEvents.map((p) => p.event_id),
        expected_value: firstAmount,
        observed_value: totalAmount,
        difference: totalAmount - firstAmount,
        confidence: 0.9,
        recommended_action: 'Immediately review and refund duplicate charges',
        metadata: {},
      };

      anomalies.push(anomaly);
    }
  }

  return anomalies;
}

/**
 * Detect refund spikes using pre-categorized refund events
 */
function detectRefundSpikesOptimized(ctx: DetectionContext): Anomaly[] {
  const { ledger, options, thresholds, eventIndices } = ctx;
  const anomalies: Anomaly[] = [];

  const refundEvents = eventIndices.refundEvents;
  if (refundEvents.length === 0) return anomalies;

  // Calculate total refunds in single pass
  let totalRefunds = 0;
  for (const event of refundEvents) {
    totalRefunds += event.amount_cents ?? 0;
  }

  // Calculate total revenue from ledger
  let totalRevenue = 0;
  for (const customer of Object.values(ledger.customers)) {
    totalRevenue += customer.total_paid_cents;
  }

  if (totalRefunds > thresholds.refund_spike_threshold_cents) {
    const refundPct = totalRevenue > 0 ? (totalRefunds / totalRevenue) * 100 : 0;

    const anomaly: Anomaly = {
      anomaly_id: generateAnomalyId('refund_spike', options.tenantId, options.projectId, 'total'),
      tenant_id: options.tenantId,
      project_id: options.projectId,
      anomaly_type: 'refund_spike',
      severity: refundPct > thresholds.refund_spike_threshold_pct ? 'critical' : 'high',
      detected_at: options.referenceDate,
      description: `Refund spike detected: $${(totalRefunds / 100).toFixed(2)} in refunds (${refundPct.toFixed(1)}% of revenue)`,
      affected_events: refundEvents.map((e) => e.event_id),
      expected_value: (totalRevenue * thresholds.refund_spike_threshold_pct) / 100,
      observed_value: totalRefunds,
      difference: totalRefunds - (totalRevenue * thresholds.refund_spike_threshold_pct) / 100,
      confidence: Math.min(refundPct / thresholds.refund_spike_threshold_pct, 1.0),
      recommended_action: 'Review refund patterns and identify root cause',
      metadata: {},
    };

    anomalies.push(anomaly);
  }

  return anomalies;
}

/**
 * Detect dispute spikes using pre-categorized dispute events
 */
function detectDisputeSpikesOptimized(ctx: DetectionContext): Anomaly[] {
  const { ledger, options, thresholds, eventIndices } = ctx;
  const anomalies: Anomaly[] = [];

  const disputeEvents = eventIndices.disputeEvents;
  if (disputeEvents.length < thresholds.dispute_spike_threshold) return anomalies;

  // Calculate totals in single passes
  let totalDisputed = 0;
  for (const event of disputeEvents) {
    totalDisputed += event.amount_cents ?? 0;
  }

  let totalRevenue = 0;
  for (const customer of Object.values(ledger.customers)) {
    totalRevenue += customer.total_paid_cents;
  }

  const disputePct = totalRevenue > 0 ? (totalDisputed / totalRevenue) * 100 : 0;

  const anomaly: Anomaly = {
    anomaly_id: generateAnomalyId('dispute_spike', options.tenantId, options.projectId, 'total'),
    tenant_id: options.tenantId,
    project_id: options.projectId,
    anomaly_type: 'dispute_spike',
    severity: disputeEvents.length > thresholds.dispute_spike_threshold * 2 ? 'critical' : 'high',
    detected_at: options.referenceDate,
    description: `Dispute spike: ${disputeEvents.length} disputes ($${(totalDisputed / 100).toFixed(2)}, ${disputePct.toFixed(1)}% of revenue)`,
    affected_events: disputeEvents.map((e) => e.event_id),
    expected_value: thresholds.dispute_spike_threshold,
    observed_value: disputeEvents.length,
    difference: disputeEvents.length - thresholds.dispute_spike_threshold,
    confidence: Math.min(disputeEvents.length / (thresholds.dispute_spike_threshold * 2), 1.0),
    recommended_action: 'Review fraud patterns and improve dispute prevention',
    metadata: {},
  };

  anomalies.push(anomaly);

  return anomalies;
}

/**
 * Detect payment failure spikes from ledger customers
 */
function detectPaymentFailureSpikesOptimized(ctx: DetectionContext): Anomaly[] {
  const { ledger, options, thresholds } = ctx;
  const anomalies: Anomaly[] = [];

  for (const customer of Object.values(ledger.customers)) {
    const totalAttempts = customer.payment_failure_count_30d + (customer.last_payment_at ? 1 : 0);

    if (totalAttempts === 0) continue;

    const failureRate = customer.payment_failure_count_30d / totalAttempts;

    if (failureRate >= thresholds.payment_failure_spike_threshold) {
      const anomaly: Anomaly = {
        anomaly_id: generateAnomalyId('payment_failure_spike', options.tenantId, options.projectId, customer.customer_id),
        tenant_id: options.tenantId,
        project_id: options.projectId,
        anomaly_type: 'payment_failure_spike',
        severity: failureRate > 0.5 ? 'critical' : 'high',
        detected_at: options.referenceDate,
        customer_id: customer.customer_id,
        description: `Payment failure spike: ${customer.payment_failure_count_30d} failures in 30 days (${(failureRate * 100).toFixed(0)}% rate)`,
        affected_events: [],
        expected_value: thresholds.payment_failure_spike_threshold * totalAttempts,
        observed_value: customer.payment_failure_count_30d,
        difference: customer.payment_failure_count_30d - (thresholds.payment_failure_spike_threshold * totalAttempts),
        confidence: failureRate,
        recommended_action: 'Review payment method and consider customer outreach',
        metadata: {},
      };

      anomalies.push(anomaly);
    }
  }

  return anomalies;
}

/**
 * Detect out of sequence events using pre-computed subscription index
 */
function detectOutOfSequenceEventsOptimized(ctx: DetectionContext): Anomaly[] {
  const { options, eventIndices } = ctx;
  const anomalies: Anomaly[] = [];

  for (const [subscriptionId, subEvents] of eventIndices.bySubscription) {
    if (subEvents.length < 2) continue;

    // Sort events by timestamp for this subscription
    const sorted = [...subEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    let hasCreated = false;
    let hasCancelled = false;

    for (const event of sorted) {
      const eventType = event.event_type;

      // Subscription can't be cancelled before created
      if (eventType === 'subscription_cancelled') {
        if (!hasCreated) {
          const anomaly: Anomaly = {
            anomaly_id: generateAnomalyId('out_of_sequence', options.tenantId, options.projectId, event.event_id),
            tenant_id: options.tenantId,
            project_id: options.projectId,
            anomaly_type: 'out_of_sequence',
            severity: 'medium',
            detected_at: options.referenceDate,
            customer_id: event.customer_id,
            subscription_id: subscriptionId,
            description: `Cancel event before create for subscription ${subscriptionId}`,
            affected_events: [event.event_id],
            confidence: 0.9,
            recommended_action: 'Review event data integrity',
            metadata: {},
          };

          anomalies.push(anomaly);
        }
        hasCancelled = true;
      }

      if (eventType === 'subscription_created') {
        hasCreated = true;
      }

      // Payment after cancellation is suspicious
      if (hasCancelled && (eventType === 'invoice_paid' || eventType === 'payment_succeeded')) {
        const anomaly: Anomaly = {
          anomaly_id: generateAnomalyId('out_of_sequence', options.tenantId, options.projectId, event.event_id),
          tenant_id: options.tenantId,
          project_id: options.projectId,
          anomaly_type: 'out_of_sequence',
          severity: 'low',
          detected_at: options.referenceDate,
          customer_id: event.customer_id,
          subscription_id: subscriptionId,
          description: `Payment event after cancellation for subscription ${subscriptionId}`,
          affected_events: [event.event_id],
          confidence: 0.6,
          recommended_action: 'Verify if payment is legitimate or requires refund',
          metadata: {},
        };

        anomalies.push(anomaly);
      }
    }
  }

  return anomalies;
}
