/**
 * Cost Snapshot module - Deterministic cost analysis
 * 
 * DD CAPABILITY: "finops.cost_snapshot"
 * 
 * Requirements:
 * - Deterministic output: same input always produces same output
 * - Cacheable with explicit invalidation rules
 * - Golden snapshot tests must pass
 * - Refusal on weak evidence if truthcore consulted
 */

import {
  CostSnapshotInputSchema,
  CostSnapshotReportSchema,
  type CostSnapshotInput,
  type CostSnapshotReport,
  type CostLineItem,
  type CostBreakdown,
  type BillingEvent,
} from '../contracts/index.js';
import { hashCanonical } from '../jobforge/deterministic.js';

export interface CostSnapshotOptions {
  tenantId: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
  stableOutput?: boolean;
}

const STABLE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/**
 * Generates a deterministic cache key for cost snapshot
 */
function generateCacheKey(
  tenantId: string,
  projectId: string,
  periodStart: string,
  periodEnd: string,
  inputHash: string
): string {
  return hashCanonical({
    tenant_id: tenantId,
    project_id: projectId,
    period_start: periodStart,
    period_end: periodEnd,
    input_hash: inputHash,
    capability: 'finops.cost_snapshot',
  });
}

/**
 * Checks if cache entry should be invalidated
 * 
 * Cache invalidation rules:
 * - period_end < now() - 24h (historical data frozen after 24h)
 * - explicit_invalidation=true (forced invalidation)
 */
export function shouldInvalidateCache(
  periodEnd: string,
  explicitInvalidation = false
): boolean {
  if (explicitInvalidation) {
    return true;
  }
  
  const periodEndDate = new Date(periodEnd);
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - 24);
  
  // If period ended more than 24h ago, data is historical and frozen
  // No need to invalidate - cache is valid indefinitely
  if (periodEndDate < cutoffDate) {
    return false;
  }
  
  // Recent data may change - allow re-computation
  return true;
}

/**
 * Build cost line items from billing events
 */
function buildCostLineItems(
  events: BillingEvent[],
  currency: string
): CostLineItem[] {
  const lineItems: CostLineItem[] = [];
  
  for (const event of events) {
    const amountCents = event.amount_cents ?? 0;
    
    let category: CostLineItem['category'];
    let description: string;
    
    switch (event.event_type) {
      case 'subscription_created':
      case 'subscription_updated':
        category = 'subscription';
        description = `Subscription ${event.subscription_id} - ${event.plan_id ?? 'unknown'}`;
        break;
      case 'invoice_paid':
        category = 'subscription';
        description = `Invoice payment ${event.invoice_id ?? 'unknown'}`;
        break;
      case 'invoice_refunded':
      case 'refund_issued':
        category = 'refund';
        description = `Refund ${event.invoice_id ?? 'unknown'} - ${amountCents} cents`;
        break;
      case 'invoice_disputed':
      case 'dispute_created':
        category = 'dispute';
        description = `Dispute ${event.invoice_id ?? 'unknown'}`;
        break;
      case 'usage_recorded':
        category = 'usage';
        description = `Usage record ${event.customer_id}`;
        break;
      default:
        category = 'other';
        description = `Event ${event.event_type}`;
    }
    
    lineItems.push({
      category,
      customer_id: event.customer_id,
      subscription_id: event.subscription_id,
      amount_cents: amountCents,
      currency,
      description,
    });
  }
  
  return lineItems;
}

/**
 * Build cost breakdown from line items
 */
function buildCostBreakdown(
  lineItems: CostLineItem[],
  includeBreakdown: boolean
): CostBreakdown {
  const byCategory: Record<string, number> = {
    subscription: 0,
    usage: 0,
    refund: 0,
    dispute: 0,
    other: 0,
  };
  
  const byCustomer: Record<string, number> = {};
  const bySubscription: Record<string, number> = {};
  
  for (const item of lineItems) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + item.amount_cents;
    
    if (item.customer_id) {
      byCustomer[item.customer_id] = (byCustomer[item.customer_id] ?? 0) + item.amount_cents;
    }
    
    if (item.subscription_id) {
      bySubscription[item.subscription_id] = (bySubscription[item.subscription_id] ?? 0) + item.amount_cents;
    }
  }
  
  return {
    by_category: byCategory,
    by_customer: includeBreakdown ? byCustomer : undefined,
    by_subscription: includeBreakdown ? bySubscription : undefined,
    line_items: lineItems,
  };
}

/**
 * Refuse on weak evidence - validates input data quality
 * 
 * Returns refusal reason if evidence is too weak to generate reliable snapshot
 */
function checkEvidenceStrength(
  input: CostSnapshotInput,
  events: BillingEvent[]
): { valid: boolean; refusalReason?: string } {
  // Check if we have any events or ledger
  if (!events.length && !input.ledger) {
    return {
      valid: false,
      refusalReason: 'INSUFFICIENT_DATA: No billing events or ledger provided',
    };
  }
  
  // Check for minimum event count to ensure statistical significance
  if (events.length < 1) {
    return {
      valid: false,
      refusalReason: 'INSUFFICIENT_EVENTS: At least one billing event required',
    };
  }
  
  // Check for currency consistency
  const currencies = new Set(events.map(e => e.currency).filter(Boolean));
  if (currencies.size > 1) {
    return {
      valid: false,
      refusalReason: 'CURRENCY_MISMATCH: Multiple currencies detected',
    };
  }
  
  // Check for valid period range
  const periodStart = new Date(input.period_start);
  const periodEnd = new Date(input.period_end);
  if (periodStart >= periodEnd) {
    return {
      valid: false,
      refusalReason: 'INVALID_PERIOD: period_start must be before period_end',
    };
  }
  
  return { valid: true };
}

/**
 * Generates a deterministic cost snapshot
 * 
 * DD CAPABILITY REQUIREMENTS:
 * - Same input always produces same output (deterministic)
 * - Cacheable with explicit invalidation rules
 * - Refuses on weak evidence
 */
export function generateCostSnapshot(
  input: CostSnapshotInput,
  options: CostSnapshotOptions
): { report: CostSnapshotReport; cacheKey: string; cached: boolean } | { refusal: string } {
  // Validate input
  const parsedInput = CostSnapshotInputSchema.parse(input);
  
  // Get billing events from input or derive from ledger
  const events = parsedInput.billing_events ?? 
    (parsedInput.ledger ? Object.values(parsedInput.ledger.customers).flatMap(c => 
      c.subscriptions.map(s => ({
        tenant_id: c.tenant_id,
        project_id: c.project_id,
        event_id: `derived_${s.subscription_id}`,
        event_type: 'subscription_created' as const,
        timestamp: s.created_at,
        customer_id: c.customer_id,
        subscription_id: s.subscription_id,
        amount_cents: s.mrr_cents,
        currency: s.currency,
        plan_id: s.plan_id,
        metadata: {},
        raw_payload: {},
      }))
    ) : []);
  
  // Check evidence strength (truthcore validation)
  const evidenceCheck = checkEvidenceStrength(parsedInput, events);
  if (!evidenceCheck.valid) {
    return { refusal: evidenceCheck.refusalReason! };
  }
  
  // Determine currency (default to USD if not specified)
  const currency = events.find(e => e.currency)?.currency ?? 'USD';
  
  // Build cost line items
  const lineItems = buildCostLineItems(events, currency);
  
  // Build cost breakdown
  const breakdown = buildCostBreakdown(lineItems, parsedInput.include_breakdown);
  
  // Calculate total cost
  const totalCostCents = lineItems.reduce((sum, item) => sum + item.amount_cents, 0);
  
  // Generate deterministic report ID
  const reportIdBase = hashCanonical({
    tenant_id: options.tenantId,
    project_id: options.projectId,
    period_start: options.periodStart,
    period_end: options.periodEnd,
  });
  const reportId = `cost-snapshot-${reportIdBase.slice(0, 16)}`;
  
  // Generate cache key
  const inputHash = hashCanonical(parsedInput);
  const cacheKey = generateCacheKey(
    options.tenantId,
    options.projectId,
    options.periodStart,
    options.periodEnd,
    inputHash
  );
  
  // Check cache invalidation
  const shouldInvalidate = shouldInvalidateCache(options.periodEnd);
  const cached = !shouldInvalidate;
  
  // Generate timestamp (stable for deterministic output)
  const generatedAt = options.stableOutput ? STABLE_TIMESTAMP : new Date().toISOString();
  
  // Count unique customers and subscriptions
  const uniqueCustomers = new Set(events.map(e => e.customer_id));
  const uniqueSubscriptions = new Set(events.map(e => e.subscription_id).filter(Boolean));
  
  const report: CostSnapshotReport = {
    tenant_id: options.tenantId,
    project_id: options.projectId,
    report_id: reportId,
    period_start: options.periodStart,
    period_end: options.periodEnd,
    generated_at: generatedAt,
    total_cost_cents: totalCostCents,
    currency,
    breakdown,
    metadata: {
      event_count: events.length,
      customer_count: uniqueCustomers.size,
      subscription_count: uniqueSubscriptions.size,
      deterministic: true,
      cacheable: true,
      cache_key: cacheKey,
    },
    version: '1.0.0',
  };
  
  // Validate output against schema
  CostSnapshotReportSchema.parse(report);
  
  return { report, cacheKey, cached };
}

/**
 * Validates cache key format and returns components
 */
export function parseCacheKey(cacheKey: string): {
  tenant_id: string;
  project_id: string;
  period_start: string;
  period_end: string;
  input_hash: string;
} | null {
  try {
    // Cache key is a hash, so we can't parse it directly
    // This function is for validation only
    if (!cacheKey || cacheKey.length !== 64) {
      return null;
    }
    return null; // Cannot parse hash back to components
  } catch {
    return null;
  }
}

export { CostSnapshotInputSchema, CostSnapshotReportSchema };
export type { CostSnapshotInput, CostSnapshotReport, CostLineItem, CostBreakdown };
