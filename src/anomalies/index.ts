/**
 * Anomaly Detection
 * 
 * Detects billing anomalies including missing events, double charges,
 * refund spikes, dispute spikes, and other operational irregularities.
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

/**
 * Detect anomalies in billing data
 */
export function detectAnomalies(
  events: NormalizedEvent[],
  ledger: LedgerState,
  options: AnomalyOptions
): AnomalyResult {
  const thresholds = options.profile?.anomaly_thresholds ?? getDefaultThresholds();
  const anomalies: Anomaly[] = [];

  // Run all detection algorithms
  anomalies.push(...detectDuplicateEvents(events, options, thresholds));
  anomalies.push(...detectMissingInvoices(events, ledger, options, thresholds));
  anomalies.push(...detectDoubleCharges(events, options, thresholds));
  anomalies.push(...detectRefundSpikes(events, ledger, options, thresholds));
  anomalies.push(...detectDisputeSpikes(events, ledger, options, thresholds));
  anomalies.push(...detectPaymentFailureSpikes(ledger, options, thresholds));
  anomalies.push(...detectOutOfSequenceEvents(events, options, thresholds));

  // Calculate statistics
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

  for (const anomaly of anomalies) {
    bySeverity[anomaly.severity]++;
    byType[anomaly.anomaly_type]++;
  }

  return {
    anomalies,
    stats: {
      total: anomalies.length,
      bySeverity,
      byType,
    },
  };
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

function generateAnomalyId(
  type: AnomalyType,
  tenantId: string,
  projectId: string,
  reference: string
): string {
  const hash = createHash('sha256')
    .update(`${type}:${tenantId}:${projectId}:${reference}`)
    .digest('hex')
    .slice(0, 16);
  return `anomaly-${type}-${hash}`;
}

/**
 * Detect duplicate events (same event_id within time window)
 */
function detectDuplicateEvents(
  events: NormalizedEvent[],
  options: AnomalyOptions,
  thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const seen = new Map<string, NormalizedEvent[]>();

  for (const event of events) {
    const existing = seen.get(event.event_id) ?? [];
    
    // Check for duplicates within time window
    for (const prev of existing) {
      const timeDiff = Math.abs(
        new Date(event.timestamp).getTime() - new Date(prev.timestamp).getTime()
      ) / 1000;

      if (timeDiff < thresholds.duplicate_event_window_seconds) {
        const anomaly: Anomaly = {
          anomaly_id: generateAnomalyId('duplicate_event', options.tenantId, options.projectId, event.event_id),
          tenant_id: options.tenantId,
          project_id: options.projectId,
          anomaly_type: 'duplicate_event',
          severity: 'high',
          detected_at: options.referenceDate,
          customer_id: event.customer_id,
          description: `Duplicate event detected: ${event.event_id} (${event.event_type}) within ${Math.round(timeDiff)}s`,
          affected_events: [event.event_id, prev.event_id],
          expected_value: 1,
          observed_value: existing.length + 1,
          difference: existing.length,
          confidence: 1.0,
          recommended_action: 'Review event ingestion pipeline for duplicate handling',
        };

        const validated = AnomalySchema.safeParse(anomaly);
        if (validated.success) {
          anomalies.push(validated.data);
        }
        break; // Only report once per duplicate
      }
    }

    existing.push(event);
    seen.set(event.event_id, existing);
  }

  return anomalies;
}

/**
 * Detect missing invoices (subscriptions without corresponding payments)
 */
function detectMissingInvoices(
  events: NormalizedEvent[],
  ledger: LedgerState,
  options: AnomalyOptions,
  _thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  // Group events by subscription
  const subscriptionEvents = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    if (event.subscription_id) {
      const list = subscriptionEvents.get(event.subscription_id) ?? [];
      list.push(event);
      subscriptionEvents.set(event.subscription_id, list);
    }
  }

  // Check each active subscription
  for (const customer of Object.values(ledger.customers)) {
    for (const subscription of customer.subscriptions) {
      if (subscription.status !== 'active') continue;

      const subEvents = subscriptionEvents.get(subscription.subscription_id) ?? [];
      const invoiceEvents = subEvents.filter((e) => 
        e.event_type === 'invoice_paid' || e.event_type === 'invoice_failed'
      );

      // If subscription is active but no invoices in period, flag it
      if (invoiceEvents.length === 0 && subscription.mrr_cents > 0) {
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
        };

        const validated = AnomalySchema.safeParse(anomaly);
        if (validated.success) {
          anomalies.push(validated.data);
        }
      }
    }
  }

  return anomalies;
}

/**
 * Detect potential double charges (multiple payments for same invoice)
 */
function detectDoubleCharges(
  events: NormalizedEvent[],
  options: AnomalyOptions,
  _thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const invoicePayments = new Map<string, NormalizedEvent[]>();

  for (const event of events) {
    if (event.invoice_id && (event.event_type === 'invoice_paid' || event.event_type === 'payment_succeeded')) {
      const list = invoicePayments.get(event.invoice_id) ?? [];
      list.push(event);
      invoicePayments.set(event.invoice_id, list);
    }
  }

  for (const [invoiceId, payments] of invoicePayments) {
    if (payments.length > 1) {
      const totalAmount = payments.reduce((sum, p) => sum + (p.amount_cents || 0), 0);
      const firstAmount = payments[0].amount_cents || 0;

      // If multiple payments with same amount, likely double charge
      const sameAmountPayments = payments.filter((p) => p.amount_cents === firstAmount);
      
      if (sameAmountPayments.length > 1) {
        const anomaly: Anomaly = {
          anomaly_id: generateAnomalyId('double_charge', options.tenantId, options.projectId, invoiceId),
          tenant_id: options.tenantId,
          project_id: options.projectId,
          anomaly_type: 'double_charge',
          severity: 'critical',
          detected_at: options.referenceDate,
          customer_id: payments[0].customer_id,
          description: `Potential double charge: ${sameAmountPayments.length} payments of ${firstAmount} cents for invoice ${invoiceId}`,
          affected_events: payments.map((p) => p.event_id),
          expected_value: firstAmount,
          observed_value: totalAmount,
          difference: totalAmount - firstAmount,
          confidence: 0.9,
          recommended_action: 'Immediately review and refund duplicate charges',
        };

        const validated = AnomalySchema.safeParse(anomaly);
        if (validated.success) {
          anomalies.push(validated.data);
        }
      }
    }
  }

  return anomalies;
}

/**
 * Detect refund spikes (unusual volume of refunds)
 */
function detectRefundSpikes(
  events: NormalizedEvent[],
  ledger: LedgerState,
  options: AnomalyOptions,
  thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  // Calculate total refunds
  const refundEvents = events.filter((e) => 
    e.event_type === 'invoice_refunded' || e.event_type === 'refund_issued'
  );
  
  const totalRefunds = refundEvents.reduce((sum, e) => sum + (e.amount_cents || 0), 0);
  const totalRevenue = Object.values(ledger.customers).reduce((sum, c) => sum + c.total_paid_cents, 0);
  
  // Check absolute threshold
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
    };

    const validated = AnomalySchema.safeParse(anomaly);
    if (validated.success) {
      anomalies.push(validated.data);
    }
  }

  return anomalies;
}

/**
 * Detect dispute spikes (unusual volume of chargebacks/disputes)
 */
function detectDisputeSpikes(
  events: NormalizedEvent[],
  ledger: LedgerState,
  options: AnomalyOptions,
  thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  const disputeEvents = events.filter((e) => 
    e.event_type === 'invoice_disputed' || 
    e.event_type === 'dispute_created' ||
    e.event_type === 'dispute_lost'
  );
  
  if (disputeEvents.length >= thresholds.dispute_spike_threshold) {
    const totalDisputed = disputeEvents.reduce((sum, e) => sum + (e.amount_cents || 0), 0);
    const totalRevenue = Object.values(ledger.customers).reduce((sum, c) => sum + c.total_paid_cents, 0);
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
    };

    const validated = AnomalySchema.safeParse(anomaly);
    if (validated.success) {
      anomalies.push(validated.data);
    }
  }

  return anomalies;
}

/**
 * Detect customers with unusual payment failure rates
 */
function detectPaymentFailureSpikes(
  ledger: LedgerState,
  options: AnomalyOptions,
  thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  for (const customer of Object.values(ledger.customers)) {
    const totalAttempts = customer.payment_failure_count_30d + (customer.last_payment_at ? 1 : 0);
    
    if (totalAttempts > 0) {
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
        };

        const validated = AnomalySchema.safeParse(anomaly);
        if (validated.success) {
          anomalies.push(validated.data);
        }
      }
    }
  }

  return anomalies;
}

/**
 * Detect events that appear out of logical sequence
 */
function detectOutOfSequenceEvents(
  events: NormalizedEvent[],
  options: AnomalyOptions,
  _thresholds: AnomalyThreshold
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  // Group by subscription
  const subscriptionEvents = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    if (event.subscription_id) {
      const list = subscriptionEvents.get(event.subscription_id) ?? [];
      list.push(event);
      subscriptionEvents.set(event.subscription_id, list);
    }
  }

  for (const [subscriptionId, subEvents] of subscriptionEvents) {
    const sorted = [...subEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    let hasCreated = false;
    let hasCancelled = false;
    
    for (const event of sorted) {
      // Subscription can't be cancelled before created
      if (event.event_type === 'subscription_cancelled') {
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
          };

          const validated = AnomalySchema.safeParse(anomaly);
          if (validated.success) {
            anomalies.push(validated.data);
          }
        }
        hasCancelled = true;
      }
      
      if (event.event_type === 'subscription_created') {
        hasCreated = true;
      }
      
      // Payment after cancellation is suspicious
      if (hasCancelled && (event.event_type === 'invoice_paid' || event.event_type === 'payment_succeeded')) {
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
        };

        const validated = AnomalySchema.safeParse(anomaly);
        if (validated.success) {
          anomalies.push(validated.data);
        }
      }
    }
  }

  return anomalies;
}
