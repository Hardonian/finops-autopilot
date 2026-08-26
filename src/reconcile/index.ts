/**
 * MRR Reconciliation & Financial Intelligence Engine
 * 
 * Computes expected MRR from subscription events and compares with
 * observed invoice payments to detect discrepancies, proration drift,
 * and calculate complete MRR waterfall movements (New, Expansion,
 * Contraction, Churn, Reactivation, Net New).
 * 
 * Performance optimizations:
 * - Single-pass event routing
 * - Incremental MRR calculation
 * - Multi-currency & proration precision
 */

import type {
  BillingEvent,
  NormalizedEvent,
  LedgerState,
  CustomerLedger,
  SubscriptionState,
  ReconReport,
  MrrDiscrepancy,
  MrrWaterfall,
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
  currency?: string;
}

/**
 * Calculate proportional daily charge for mid-cycle billing adjustments
 */
export function calculateDailyProration(
  mrrCents: number,
  activeStart: string,
  activeEnd: string,
  periodStart: string,
  periodEnd: string
): number {
  const pStart = Math.max(new Date(activeStart).getTime(), new Date(periodStart).getTime());
  const pEnd = Math.min(new Date(activeEnd).getTime(), new Date(periodEnd).getTime());
  const fullPeriodDuration = new Date(periodEnd).getTime() - new Date(periodStart).getTime();

  if (pEnd <= pStart || fullPeriodDuration <= 0) return 0;

  const activeDuration = pEnd - pStart;
  const fraction = activeDuration / fullPeriodDuration;
  return Math.round(mrrCents * fraction);
}

/**
 * Build ledger state from normalized billing events
 * 
 * Performance: O(n) where n = number of events
 */
export function buildLedger(
  events: NormalizedEvent[],
  options: ReconcileOptions
): LedgerState {
  const customers = new Map<string, CustomerLedger>();
  const subscriptions = new Map<string, SubscriptionState>();

  const sortedEvents = events;

  for (const event of sortedEvents) {
    if (event.timestamp < options.periodStart || event.timestamp > options.periodEnd) {
      continue;
    }

    const eventType = event.event_type;

    switch (eventType) {
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

  let totalMrr = 0;
  let activeSubscriptions = 0;

  for (const customer of customers.values()) {
    let customerMrr = 0;
    let customerActiveSubs = 0;

    for (const sub of customer.subscriptions) {
      if (sub.status === 'active') {
        customerMrr += sub.mrr_cents;
        customerActiveSubs++;
      }
    }

    customer.total_mrr_cents = customerMrr;
    totalMrr += customerMrr;
    activeSubscriptions += customerActiveSubs;
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
    throw new Error(`Ledger validation failed: ${validated.error.errors.map((e) => e.message).join(', ')}`);
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

  const subscription: SubscriptionState = {
    subscription_id: event.subscription_id,
    customer_id: event.customer_id,
    plan_id: event.plan_id ?? 'default',
    status: 'active',
    current_period_start: event.period_start ?? event.timestamp,
    current_period_end: event.period_end ?? event.timestamp,
    mrr_cents: event.amount_cents ?? 0,
    currency: event.currency ?? 'USD',
    created_at: event.timestamp,
    cancel_at_period_end: false,
  };

  subscriptions.set(event.subscription_id, subscription);

  const customer = getOrCreateCustomer(event.customer_id, customers, options);
  customer.subscriptions = customer.subscriptions.filter((s) => s.subscription_id !== event.subscription_id);
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

  let subscription = subscriptions.get(event.subscription_id);
  if (!subscription) {
    handleSubscriptionCreated(event, subscriptions, customers, options);
    return;
  }

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
 * Compute detailed MRR Waterfall decomposition from events
 */
export function computeMrrWaterfall(
  events: NormalizedEvent[],
  options: ReconcileOptions
): MrrWaterfall {
  let startingMrr = 0;
  let newMrr = 0;
  let expansionMrr = 0;
  let contractionMrr = 0;
  let churnMrr = 0;
  let reactivationMrr = 0;

  const previousCustomerMrr = new Map<string, number>();
  const customerHadActive = new Set<string>();

  // First pass: identify starting MRR before period start
  for (const event of events) {
    if (event.timestamp < options.periodStart) {
      if (event.event_type === 'subscription_created' || event.event_type === 'subscription_updated') {
        const amt = event.amount_cents ?? 0;
        previousCustomerMrr.set(event.customer_id, amt);
        customerHadActive.add(event.customer_id);
      } else if (event.event_type === 'subscription_cancelled') {
        previousCustomerMrr.set(event.customer_id, 0);
      }
    }
  }

  for (const mrr of previousCustomerMrr.values()) {
    startingMrr += mrr;
  }

  // Second pass: analyze movements within the reconciliation period
  for (const event of events) {
    if (event.timestamp < options.periodStart || event.timestamp > options.periodEnd) {
      continue;
    }

    const customerId = event.customer_id;
    const currentMrr = previousCustomerMrr.get(customerId) ?? 0;
    const hadActiveBefore = customerHadActive.has(customerId);

    if (event.event_type === 'subscription_created') {
      const amt = event.amount_cents ?? 0;
      if (hadActiveBefore && currentMrr === 0) {
        reactivationMrr += amt;
      } else {
        newMrr += amt;
      }
      previousCustomerMrr.set(customerId, currentMrr + amt);
      customerHadActive.add(customerId);
    } else if (event.event_type === 'subscription_updated') {
      const newAmt = event.amount_cents ?? 0;
      const diff = newAmt - currentMrr;
      if (diff > 0) {
        expansionMrr += diff;
      } else if (diff < 0) {
        contractionMrr += Math.abs(diff);
      }
      previousCustomerMrr.set(customerId, newAmt);
    } else if (event.event_type === 'subscription_cancelled') {
      churnMrr += currentMrr;
      previousCustomerMrr.set(customerId, 0);
    }
  }

  const netNewMrr = newMrr + expansionMrr + reactivationMrr - contractionMrr - churnMrr;
  const endingMrr = startingMrr + netNewMrr;

  return {
    starting_mrr_cents: startingMrr,
    new_mrr_cents: newMrr,
    expansion_mrr_cents: expansionMrr,
    contraction_mrr_cents: contractionMrr,
    churn_mrr_cents: churnMrr,
    reactivation_mrr_cents: reactivationMrr,
    net_new_mrr_cents: netNewMrr,
    ending_mrr_cents: endingMrr,
    currency: options.currency ?? 'USD',
    period_start: options.periodStart,
    period_end: options.periodEnd,
  };
}

/**
 * Reconcile expected MRR against observed revenue and generate audit report
 */
export function reconcileMrr(
  ledger: LedgerState,
  options: ReconcileOptions,
  events: NormalizedEvent[] = []
): ReconReport {
  const discrepancies: MrrDiscrepancy[] = [];
  const missingEvents: BillingEvent[] = [];
  const unmatchedObservations: Record<string, unknown>[] = [];
  const remediationPlaybook: string[] = [];

  for (const customer of Object.values(ledger.customers)) {
    for (const subscription of customer.subscriptions) {
      if (subscription.status === 'canceled') continue;

      const expectedMrr = subscription.mrr_cents;
      const observedMrr = customer.total_paid_cents > 0
        ? Math.min(expectedMrr, customer.total_paid_cents)
        : 0;

      const difference = expectedMrr - observedMrr;

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

        if (reason === 'missing_invoice') {
          remediationPlaybook.push(
            `Customer ${customer.customer_id}: Generate catch-up invoice of $${(difference / 100).toFixed(2)} for subscription ${subscription.subscription_id}`
          );
        } else {
          remediationPlaybook.push(
            `Customer ${customer.customer_id}: Issue credit note or refund of $${(Math.abs(difference) / 100).toFixed(2)} on subscription ${subscription.subscription_id}`
          );
        }
      }
    }

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
      remediationPlaybook.push(
        `Customer ${customer.customer_id}: Trigger dunning retry workflow (30d payment failures: ${customer.payment_failure_count_30d})`
      );
    }
  }

  const totalExpected = ledger.total_mrr_cents;
  const totalObserved = Object.values(ledger.customers).reduce(
    (sum, c) => sum + c.total_paid_cents,
    0
  );
  const totalDifference = totalExpected - totalObserved;

  const waterfall = events.length > 0
    ? computeMrrWaterfall(events, options)
    : {
        starting_mrr_cents: totalExpected,
        new_mrr_cents: 0,
        expansion_mrr_cents: 0,
        contraction_mrr_cents: 0,
        churn_mrr_cents: 0,
        reactivation_mrr_cents: 0,
        net_new_mrr_cents: 0,
        ending_mrr_cents: totalExpected,
        currency: options.currency ?? 'USD',
        period_start: options.periodStart,
        period_end: options.periodEnd,
      };

  const reportId = `recon-${options.tenantId}-${options.projectId}-${options.periodStart}-${options.periodEnd}`;

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
    waterfall,
    remediation_playbook: remediationPlaybook,
    is_balanced: totalDifference === 0 && discrepancies.length === 0,
    report_hash: reportHash,
    version: '1.0.0',
  };

  const validated = ReconReportSchema.safeParse(report);
  if (!validated.success) {
    throw new Error(`Recon report validation failed: ${validated.error.errors.map((e) => e.message).join(', ')}`);
  }

  return validated.data;
}
