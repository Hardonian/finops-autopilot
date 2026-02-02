/**
 * Churn Risk Detection
 * 
 * Calculates explainable churn risk scores based on billing signals:
 * - Payment failures
 * - Usage drops (via optional external input)
 * - Support tickets
 * - Plan downgrades
 * 
 * No financial advice - operational insights only.
 */

import type {
  LedgerState,
  ChurnRisk,
  ChurnSignal,
  ChurnInputs,
  Profile,
  ChurnThreshold,
} from '../contracts/index.js';
import { ChurnRiskSchema } from '../contracts/index.js';
import { createHash } from 'crypto';

export interface ChurnOptions {
  tenantId: string;
  projectId: string;
  referenceDate: string;
  profile?: Profile;
}

export interface ChurnResult {
  risks: ChurnRisk[];
  stats: {
    totalAssessed: number;
    byLevel: {
      low: number;
      medium: number;
      high: number;
      critical: number;
    };
    averageScore: number;
  };
}

/**
 * Assess churn risk for all customers in ledger
 * 
 * This function provides operational insights based on observable billing
 * patterns. It does not predict actual churn or provide financial advice.
 */
export function assessChurnRisk(
  inputs: ChurnInputs,
  options: ChurnOptions
): ChurnResult {
  const thresholds = options.profile?.churn_thresholds ?? getDefaultThresholds();
  const risks: ChurnRisk[] = [];

  // Create lookup maps for external data
  const usageByCustomer = new Map<string, typeof inputs.usage_metrics>();
  for (const metric of inputs.usage_metrics) {
    const list = usageByCustomer.get(metric.customer_id) ?? [];
    list.push(metric);
    usageByCustomer.set(metric.customer_id, list);
  }

  const ticketsByCustomer = new Map<string, typeof inputs.support_tickets>();
  for (const ticket of inputs.support_tickets) {
    const list = ticketsByCustomer.get(ticket.customer_id) ?? [];
    list.push(ticket);
    ticketsByCustomer.set(ticket.customer_id, list);
  }

  const downgradesByCustomer = new Map<string, typeof inputs.plan_downgrades>();
  for (const downgrade of inputs.plan_downgrades) {
    const list = downgradesByCustomer.get(downgrade.customer_id) ?? [];
    list.push(downgrade);
    downgradesByCustomer.set(downgrade.customer_id, list);
  }

  // Assess each customer
  for (const customer of Object.values(inputs.ledger.customers)) {
    const signals: ChurnSignal[] = [];

    // Signal 1: Payment failures
    const paymentSignal = assessPaymentFailures(customer, thresholds);
    if (paymentSignal) signals.push(paymentSignal);

    // Signal 2: Usage drop (from external data)
    const usageMetrics = usageByCustomer.get(customer.customer_id) ?? [];
    const usageSignal = assessUsageDrop(usageMetrics, thresholds);
    if (usageSignal) signals.push(usageSignal);

    // Signal 3: Support tickets
    const tickets = ticketsByCustomer.get(customer.customer_id) ?? [];
    const ticketSignal = assessSupportTickets(tickets, thresholds);
    if (ticketSignal) signals.push(ticketSignal);

    // Signal 4: Plan downgrades
    const downgrades = downgradesByCustomer.get(customer.customer_id) ?? [];
    const downgradeSignal = assessPlanDowngrades(downgrades, thresholds);
    if (downgradeSignal) signals.push(downgradeSignal);

    // Signal 5: No recent payment (inactivity)
    const inactivitySignal = assessInactivity(customer, inputs.reference_date, thresholds);
    if (inactivitySignal) signals.push(inactivitySignal);

    // Calculate overall risk score
    const riskScore = calculateRiskScore(signals, thresholds);
    const riskLevel = determineRiskLevel(riskScore, thresholds);

    // Generate explanation
    const explanation = generateExplanation(customer.customer_id, signals, riskScore);

    // Generate recommended actions
    const recommendedActions = generateRecommendations(signals, riskLevel);

    const risk: ChurnRisk = {
      risk_id: generateRiskId(options.tenantId, options.projectId, customer.customer_id, options.referenceDate),
      tenant_id: options.tenantId,
      project_id: options.projectId,
      customer_id: customer.customer_id,
      calculated_at: options.referenceDate,
      risk_score: riskScore,
      risk_level: riskLevel,
      contributing_signals: signals,
      explanation,
      recommended_actions: recommendedActions,
      supporting_data: {
        mrr_cents: customer.total_mrr_cents,
        subscription_count: customer.subscriptions.length,
        payment_failures_30d: customer.payment_failure_count_30d,
        usage_metrics_count: usageMetrics.length,
        support_tickets_count: tickets.length,
        plan_downgrades_count: downgrades.length,
      },
      version: '1.0.0',
    };

    const validated = ChurnRiskSchema.safeParse(risk);
    if (validated.success) {
      risks.push(validated.data);
    }
  }

  // Sort by risk score (highest first)
  risks.sort((a, b) => b.risk_score - a.risk_score);

  // Calculate stats
  const stats = {
    totalAssessed: risks.length,
    byLevel: {
      low: risks.filter((r) => r.risk_level === 'low').length,
      medium: risks.filter((r) => r.risk_level === 'medium').length,
      high: risks.filter((r) => r.risk_level === 'high').length,
      critical: risks.filter((r) => r.risk_level === 'critical').length,
    },
    averageScore: risks.length > 0 
      ? risks.reduce((sum, r) => sum + r.risk_score, 0) / risks.length 
      : 0,
  };

  return { risks, stats };
}

function getDefaultThresholds(): ChurnThreshold {
  return {
    payment_failure_weight: 0.3,
    usage_drop_weight: 0.25,
    support_ticket_weight: 0.2,
    plan_downgrade_weight: 0.15,
    inactivity_weight: 0.1,
    risk_score_low_threshold: 30,
    risk_score_medium_threshold: 50,
    risk_score_high_threshold: 75,
  };
}

function generateRiskId(
  tenantId: string,
  projectId: string,
  customerId: string,
  referenceDate: string
): string {
  const hash = createHash('sha256')
    .update(`${tenantId}:${projectId}:${customerId}:${referenceDate}`)
    .digest('hex')
    .slice(0, 16);
  return `churn-${hash}`;
}

/**
 * Assess payment failure signal
 */
function assessPaymentFailures(
  customer: { customer_id: string; payment_failure_count_30d: number },
  thresholds: ChurnThreshold
): ChurnSignal | null {
  if (customer.payment_failure_count_30d === 0) return null;

  // Weight increases with failure count (capped at 0.9)
  const baseWeight = thresholds.payment_failure_weight;
  const failureMultiplier = Math.min(customer.payment_failure_count_30d * 0.2, 2);
  const weight = Math.min(baseWeight * failureMultiplier, 0.9);

  return {
    signal_type: 'payment_failures',
    weight,
    evidence: [
      `${customer.payment_failure_count_30d} payment failure(s) in last 30 days`,
      'Payment failures correlate with involuntary churn risk',
    ],
    raw_values: {
      failure_count: customer.payment_failure_count_30d,
      base_weight: baseWeight,
    },
  };
}

/**
 * Assess usage drop signal (requires external usage data)
 */
function assessUsageDrop(
  metrics: Array<{ metric_name: string; current_value: number; previous_value: number; period_days: number }>,
  thresholds: ChurnThreshold
): ChurnSignal | null {
  if (metrics.length === 0) return null;

  // Find metrics with significant drops
  const drops = metrics
    .filter((m) => m.previous_value > 0)
    .map((m) => ({
      ...m,
      drop_pct: ((m.previous_value - m.current_value) / m.previous_value) * 100,
    }))
    .filter((m) => m.drop_pct > 30); // At least 30% drop

  if (drops.length === 0) return null;

  // Use the largest drop for scoring
  const maxDrop = drops.reduce((max, m) => (m.drop_pct > max.drop_pct ? m : max));
  const dropSeverity = Math.min(maxDrop.drop_pct / 100, 1);
  const weight = thresholds.usage_drop_weight * dropSeverity;

  return {
    signal_type: 'usage_drop',
    weight,
    evidence: [
      `Usage metric "${maxDrop.metric_name}" dropped ${maxDrop.drop_pct.toFixed(1)}%`,
      `From ${maxDrop.previous_value.toFixed(2)} to ${maxDrop.current_value.toFixed(2)}`,
      'Usage drops often precede voluntary churn',
    ],
    raw_values: {
      metric_name: maxDrop.metric_name,
      drop_percentage: maxDrop.drop_pct,
      period_days: maxDrop.period_days,
    },
  };
}

/**
 * Assess support ticket signal
 */
function assessSupportTickets(
  tickets: Array<{ severity: string; status: string; category: string }>,
  thresholds: ChurnThreshold
): ChurnSignal | null {
  if (tickets.length === 0) return null;

  // Weight based on ticket count and severity
  const openTickets = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const criticalTickets = tickets.filter((t) => t.severity === 'critical');
  const highTickets = tickets.filter((t) => t.severity === 'high');

  let severityMultiplier = 1;
  if (criticalTickets.length > 0) severityMultiplier = 2;
  else if (highTickets.length > 0) severityMultiplier = 1.5;
  else if (openTickets.length > 3) severityMultiplier = 1.3;

  const weight = Math.min(
    thresholds.support_ticket_weight * severityMultiplier * Math.sqrt(tickets.length),
    0.9
  );

  return {
    signal_type: 'support_tickets',
    weight,
    evidence: [
      `${tickets.length} support ticket(s), ${openTickets.length} open`,
      criticalTickets.length > 0 ? `${criticalTickets.length} critical severity` : null,
      'Support friction correlates with churn intent',
    ].filter(Boolean) as string[],
    raw_values: {
      total_tickets: tickets.length,
      open_tickets: openTickets.length,
      critical_tickets: criticalTickets.length,
    },
  };
}

/**
 * Assess plan downgrade signal
 */
function assessPlanDowngrades(
  downgrades: Array<{ from_plan: string; to_plan: string; changed_at: string }>,
  thresholds: ChurnThreshold
): ChurnSignal | null {
  if (downgrades.length === 0) return null;

  // Recent downgrades weighted more heavily
  const now = new Date();
  const recentDowngrades = downgrades.filter((d) => {
    const daysAgo = (now.getTime() - new Date(d.changed_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysAgo <= 30;
  });

  const weight = Math.min(
    thresholds.plan_downgrade_weight * (1 + recentDowngrades.length * 0.5),
    0.8
  );

  return {
    signal_type: 'plan_downgrade',
    weight,
    evidence: [
      `${downgrades.length} plan downgrade(s) recorded`,
      recentDowngrades.length > 0 
        ? `${recentDowngrades.length} downgrade(s) in last 30 days` 
        : 'Most recent downgrade >30 days ago',
      'Downgrades often precede full cancellation',
    ],
    raw_values: {
      total_downgrades: downgrades.length,
      recent_downgrades: recentDowngrades.length,
      last_downgrade_at: downgrades[downgrades.length - 1]?.changed_at,
    },
  };
}

/**
 * Assess inactivity signal (no recent payment)
 */
function assessInactivity(
  customer: { customer_id: string; last_payment_at?: string; total_mrr_cents: number },
  referenceDate: string,
  thresholds: ChurnThreshold
): ChurnSignal | null {
  // Only flag paying customers with MRR
  if (customer.total_mrr_cents === 0) return null;

  const reference = new Date(referenceDate);
  const lastPayment = customer.last_payment_at ? new Date(customer.last_payment_at) : null;
  
  // If no payment ever or payment > 45 days ago
  const daysSincePayment = lastPayment 
    ? (reference.getTime() - lastPayment.getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;

  if (daysSincePayment < 35) return null; // Not inactive enough

  const inactivitySeverity = Math.min(daysSincePayment / 90, 1); // Max at 90 days
  const weight = thresholds.inactivity_weight * inactivitySeverity;

  return {
    signal_type: 'no_recent_login',
    weight,
    evidence: [
      lastPayment 
        ? `No payment in ${Math.round(daysSincePayment)} days` 
        : 'No recorded payment activity',
      'Inactivity indicates potential disengagement',
    ],
    raw_values: {
      days_since_payment: daysSincePayment === Infinity ? null : Math.round(daysSincePayment),
      mrr_cents: customer.total_mrr_cents,
    },
  };
}

/**
 * Calculate overall risk score from signals
 */
function calculateRiskScore(signals: ChurnSignal[], thresholds: ChurnThreshold): number {
  if (signals.length === 0) return 0;

  // Weighted sum of signal weights
  const weightedSum = signals.reduce((sum, s) => sum + s.weight * 100, 0);
  
  // Apply diminishing returns for multiple signals
  const signalMultiplier = 1 + (signals.length - 1) * 0.1;
  
  const score = Math.min(weightedSum * signalMultiplier, 100);
  return Math.round(score);
}

/**
 * Determine risk level from score
 */
function determineRiskLevel(
  score: number,
  thresholds: ChurnThreshold
): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= thresholds.risk_score_high_threshold) return 'critical';
  if (score >= thresholds.risk_score_medium_threshold) return 'high';
  if (score >= thresholds.risk_score_low_threshold) return 'medium';
  return 'low';
}

/**
 * Generate human-readable explanation
 */
function generateExplanation(
  customerId: string,
  signals: ChurnSignal[],
  score: number
): string {
  if (signals.length === 0) {
    return `Customer ${customerId} shows no significant churn risk signals.`;
  }

  const signalDescriptions = signals
    .sort((a, b) => b.weight - a.weight)
    .map((s) => {
      const weightPct = Math.round(s.weight * 100);
      return `${s.signal_type.replace(/_/g, ' ')} (${weightPct}% impact)`;
    });

  return `Customer ${customerId} has risk score ${score}/100 based on: ${signalDescriptions.join(', ')}.`;
}

/**
 * Generate recommended actions based on signals
 */
function generateRecommendations(
  signals: ChurnSignal[],
  riskLevel: string
): string[] {
  const recommendations: string[] = [];

  if (riskLevel === 'critical') {
    recommendations.push('Immediate: Contact customer success team for intervention');
  } else if (riskLevel === 'high') {
    recommendations.push('Schedule proactive customer outreach within 48 hours');
  } else if (riskLevel === 'medium') {
    recommendations.push('Monitor for additional signals; include in next health review');
  }

  for (const signal of signals) {
    switch (signal.signal_type) {
      case 'payment_failures':
        recommendations.push('Payment: Review billing settings and payment methods');
        break;
      case 'usage_drop':
        recommendations.push('Usage: Investigate adoption blockers with customer');
        break;
      case 'support_tickets':
        recommendations.push('Support: Ensure all tickets resolved satisfactorily');
        break;
      case 'plan_downgrade':
        recommendations.push('Revenue: Explore upgrade incentives or alternative plans');
        break;
      case 'no_recent_login':
        recommendations.push('Engagement: Send re-activation campaign');
        break;
    }
  }

  return recommendations;
}
