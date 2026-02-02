/**
 * MRR Reconciliation
 * 
 * Computes expected MRR from subscription events and compares with
 * observed invoice payments to detect discrepancies.
 */

import type {
  BillingEvent,
  NormalizedEvent,
  LedgerState,
  CustomerLedger,
  SubscriptionState,
  ReconReport,
  MrrDiscrepancy,
} from '../contracts/index.js';
import {
  LedgerStateSchema,
  ReconReportSchema,
} from '../contracts/index.js';
import { createHash } from 'crypto';

export interface ReconcileOptions {
  tenantId: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Build ledger state from normalized billing events
 */
export function buildLedger(
  events: NormalizedEvent[],
  options: ReconcileOptions
): LedgerState {
  const customers = new Map<string, CustomerLedger>();
  const subscriptions = new Map<string, SubscriptionState>();

  // Sort events chronologically
  const sortedEvents = [...events].sort((a, b) => 
    a.timestamp.localeCompare(b.timestamp)
  );

  for (const event of sortedEvents) {
    // Only process events within the reconciliation period
    if (event.timestamp < options.periodStart || event.timestamp > options.periodEnd) {
      continue;
    }

    switch (event.event_type) {
      case 'subscription_created':
        handleSubscriptionCreated(event, subscriptions, customers, options);
        break;
      case 'subscription_updated':
        handleSubscriptionUpdated(event, subscriptions, customers, options);
        break;
      case 'subscription_cancelled':
        handleSubscriptionCancelled(event, subscriptions, customers, options);
        break;
      case 'invoice_paid':
        handleInvoicePaid(event, customers, options);
        break;
      case 'invoice_refunded':
        handleInvoiceRefunded(event, customers, options);
        break;
      case 'invoice_disputed':
        handleInvoiceDisputed(event, customers, options);
        break;
      case 'payment_succeeded':
        handlePaymentSucceeded(event, customers, options);
        break;
      case 'payment_failed':
        handlePaymentFailed(event, customers, options);
        break;
    }
  }

  // Calculate totals
  let totalMrr = 0;
  let activeSubscriptions = 0;

  for (const customer of customers.values()) {
    // Recalculate customer totals
    customer.total_mrr_cents = customer.subscriptions
      .filter((s) => s.status === 'active')
      .reduce((sum, s) => sum + s.mrr_cents, 0);
    
    totalMrr += customer.total_mrr_cents;
    activeSubscriptions += customer.subscriptions.filter((s) => s.status === 'active').length;
  }

  const ledger: LedgerState = {
    tenant_id: options.tenantId,
    project_id: options.projectId,
    computed_at: new Date().toISOString(),
    customers: Object.fromEntries(customers),
    total_mrr_cents: totalMrr,
    total_customers: customers.size,
    active_subscriptions: activeSubscriptions,
    event_count: sortedEvents.length,
    version: '1.0.0',
  };

  const validated = LedgerStateSchema.safeParse(ledger);
  if (!validated.success) {
    throw new Error(`Ledger validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}

function getOrCreateCustomer(
  customerId: string,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): CustomerLedger {
  let customer = customers.get(customerId);
  if (!customer) {
    customer = {
      customer_id: customerId,
      tenant_id: options.tenantId,
      project_id: options.projectId,
      subscriptions: [],
      total_mrr_cents: 0,
      total_paid_cents: 0,
      total_refunded_cents: 0,
      total_disputed_cents: 0,
      payment_failure_count_30d: 0,
      updated_at: new Date().toISOString(),
    };
    customers.set(customerId, customer);
  }
  return customer;
}

function handleSubscriptionCreated(
  event: BillingEvent,
  subscriptions: Map<string, SubscriptionState>,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  if (!event.subscription_id) return;

  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  
  const subscription: SubscriptionState = {
    subscription_id: event.subscription_id,
    customer_id: event.customer_id,
    plan_id: event.plan_id || 'unknown',
    status: 'active',
    current_period_start: event.period_start || event.timestamp,
    current_period_end: event.period_end || event.timestamp,
    mrr_cents: event.amount_cents || 0,
    currency: event.currency || 'USD',
    created_at: event.timestamp,
    cancel_at_period_end: false,
  };

  subscriptions.set(event.subscription_id, subscription);
  customer.subscriptions.push(subscription);
  customer.updated_at = event.timestamp;
}

function handleSubscriptionUpdated(
  event: BillingEvent,
  subscriptions: Map<string, SubscriptionState>,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  if (!event.subscription_id) return;

  const subscription = subscriptions.get(event.subscription_id);
  if (!subscription) return;

  // Update fields if provided
  if (event.plan_id) subscription.plan_id = event.plan_id;
  if (event.amount_cents !== undefined) subscription.mrr_cents = event.amount_cents;
  if (event.period_start) subscription.current_period_start = event.period_start;
  if (event.period_end) subscription.current_period_end = event.period_end;
  if (event.currency) subscription.currency = event.currency;

  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  customer.updated_at = event.timestamp;
}

function handleSubscriptionCancelled(
  event: BillingEvent,
  subscriptions: Map<string, SubscriptionState>,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  if (!event.subscription_id) return;

  const subscription = subscriptions.get(event.subscription_id);
  if (!subscription) return;

  subscription.status = 'canceled';
  subscription.canceled_at = event.timestamp;

  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  customer.updated_at = event.timestamp;
}

function handleInvoicePaid(
  event: BillingEvent,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  
  if (event.amount_cents) {
    customer.total_paid_cents += event.amount_cents;
  }
  customer.last_invoice_at = event.timestamp;
  customer.updated_at = event.timestamp;
}

function handleInvoiceRefunded(
  event: BillingEvent,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  
  if (event.amount_cents) {
    customer.total_refunded_cents += event.amount_cents;
  }
  customer.updated_at = event.timestamp;
}

function handleInvoiceDisputed(
  event: BillingEvent,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  
  if (event.amount_cents) {
    customer.total_disputed_cents += event.amount_cents;
  }
  customer.updated_at = event.timestamp;
}

function handlePaymentSucceeded(
  event: BillingEvent,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  customer.last_payment_at = event.timestamp;
  customer.updated_at = event.timestamp;
}

function handlePaymentFailed(
  event: BillingEvent,
  customers: Map<string, CustomerLedger>,
  options: ReconcileOptions
): void {
  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  customer.payment_failure_count_30d += 1;
  customer.updated_at = event.timestamp;
}

/**
 * Reconcile expected MRR against observed revenue
 */
export function reconcileMrr(
  ledger: LedgerState,
  options: ReconcileOptions
): ReconReport {
  const discrepancies: MrrDiscrepancy[] = [];
  const missingEvents: BillingEvent[] = [];
  const unmatchedObservations: Record<string, unknown>[] = [];

  // Analyze each customer for discrepancies
  for (const customer of Object.values(ledger.customers)) {
    for (const subscription of customer.subscriptions) {
      // Skip canceled subscriptions for MRR calculation
      if (subscription.status === 'canceled') continue;

      const expectedMrr = subscription.mrr_cents;
      
      // Calculate observed MRR based on actual payments in period
      // This is simplified - real implementation would analyze invoice history
      const observedMrr = customer.total_paid_cents > 0 
        ? Math.min(expectedMrr, customer.total_paid_cents) 
        : 0;

      const difference = expectedMrr - observedMrr;

      // Flag discrepancies above threshold (e.g., > $1 difference)
      if (Math.abs(difference) > 100) {
        const reason = difference > 0 
          ? ('missing_invoice' as const)
          : ('double_charge' as const);

        discrepancies.push({
          subscription_id: subscription.subscription_id,
          customer_id: customer.customer_id,
          expected_mrr_cents: expectedMrr,
          observed_mrr_cents: observedMrr,
          difference_cents: difference,
          reason,
          events_involved: [],
        });
      }
    }

    // Check for payment failures indicating missing successful payments
    if (customer.payment_failure_count_30d > 0 && !customer.last_payment_at) {
      missingEvents.push({
        tenant_id: options.tenantId,
        project_id: options.projectId,
        event_id: `missing-payment-${customer.customer_id}`,
        event_type: 'payment_succeeded',
        timestamp: options.periodEnd,
        customer_id: customer.customer_id,
        metadata: {
          note: 'Expected payment based on subscription but none found',
          failure_count: customer.payment_failure_count_30d,
        },
        raw_payload: {},
      });
    }
  }

  const totalExpected = ledger.total_mrr_cents;
  const totalObserved = Object.values(ledger.customers).reduce(
    (sum, c) => sum + c.total_paid_cents, 
    0
  );
  const totalDifference = totalExpected - totalObserved;

  // Generate deterministic report ID
  const reportId = `recon-${options.tenantId}-${options.projectId}-${options.periodStart}-${options.periodEnd}`;

  // Compute report hash for auditing
  const reportContent = {
    tenant_id: options.tenantId,
    project_id: options.projectId,
    period_start: options.periodStart,
    period_end: options.periodEnd,
    discrepancies: discrepancies.map((d) => ({
      subscription_id: d.subscription_id,
      difference_cents: d.difference_cents,
      reason: d.reason,
    })),
  };

  const reportHash = createHash('sha256')
    .update(JSON.stringify(reportContent))
    .digest('hex');

  const report: ReconReport = {
    tenant_id: options.tenantId,
    project_id: options.projectId,
    report_id: reportId,
    generated_at: new Date().toISOString(),
    period_start: options.periodStart,
    period_end: options.periodEnd,
    total_expected_mrr_cents: totalExpected,
    total_observed_mrr_cents: totalObserved,
    total_difference_cents: totalDifference,
    discrepancies,
    missing_events: missingEvents,
    unmatched_observations: unmatchedObservations,
    is_balanced: totalDifference === 0 && discrepancies.length === 0,
    report_hash: reportHash,
    version: '1.0.0',
  };

  const validated = ReconReportSchema.safeParse(report);
  if (!validated.success) {
    throw new Error(`Recon report validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}
