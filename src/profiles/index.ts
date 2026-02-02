/**
 * Profile Management
 * 
 * Provides base and per-app profiles for configuring thresholds,
 * alert routing, and redaction settings.
 */

import type { Profile, AnomalyThreshold, ChurnThreshold } from '../contracts/index.js';
import { ProfileSchema } from '../contracts/index.js';

// Default anomaly thresholds
const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThreshold = {
  refund_spike_threshold_cents: 100000, // $1,000
  refund_spike_threshold_pct: 10,       // 10% of revenue
  dispute_spike_threshold: 5,           // 5 disputes
  payment_failure_spike_threshold: 0.25, // 25% failure rate
  duplicate_event_window_seconds: 300,  // 5 minutes
  usage_drop_threshold_pct: 50,         // 50% drop
};

// Default churn thresholds
const DEFAULT_CHURN_THRESHOLDS: ChurnThreshold = {
  payment_failure_weight: 0.3,
  usage_drop_weight: 0.25,
  support_ticket_weight: 0.2,
  plan_downgrade_weight: 0.15,
  inactivity_weight: 0.1,
  risk_score_low_threshold: 30,
  risk_score_medium_threshold: 50,
  risk_score_high_threshold: 75,
};

/**
 * Base profile - sensible defaults for most SaaS applications
 */
export const baseProfile: Profile = {
  profile_id: 'base',
  name: 'Base Profile',
  description: 'Default configuration suitable for most SaaS applications',
  anomaly_thresholds: DEFAULT_ANOMALY_THRESHOLDS,
  churn_thresholds: DEFAULT_CHURN_THRESHOLDS,
  alert_routing: {
    channels: ['email'],
    severity_filter: ['high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * JobForge profile - optimized for JobForge SaaS
 */
export const jobforgeProfile: Profile = {
  profile_id: 'jobforge',
  tenant_id: 'jobforge',
  name: 'JobForge Profile',
  description: 'Optimized for JobForge batch processing platform',
  plan_ids: ['starter', 'professional', 'enterprise'],
  anomaly_thresholds: {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    refund_spike_threshold_cents: 50000,  // More sensitive ($500)
    payment_failure_spike_threshold: 0.2,  // 20% failure rate
  },
  churn_thresholds: {
    ...DEFAULT_CHURN_THRESHOLDS,
    payment_failure_weight: 0.35,  // Higher weight on payment issues
    usage_drop_weight: 0.3,        // Higher weight on usage
  },
  alert_routing: {
    channels: ['email', 'slack'],
    severity_filter: ['medium', 'high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * Settler profile - optimized for Settler payment reconciliation
 */
export const settlerProfile: Profile = {
  profile_id: 'settler',
  tenant_id: 'settler',
  name: 'Settler Profile',
  description: 'Optimized for Settler payment reconciliation service',
  plan_ids: ['basic', 'business', 'enterprise'],
  anomaly_thresholds: {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    refund_spike_threshold_cents: 25000,  // Very sensitive ($250)
    dispute_spike_threshold: 3,           // Very sensitive (3 disputes)
    duplicate_event_window_seconds: 60,   // 1 minute window for dups
  },
  churn_thresholds: {
    ...DEFAULT_CHURN_THRESHOLDS,
    payment_failure_weight: 0.4,
    risk_score_high_threshold: 70,  // Lower threshold for high risk
  },
  alert_routing: {
    channels: ['email', 'pagerduty'],
    severity_filter: ['high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * Readylayer profile - optimized for Readylayer infrastructure
 */
export const readylayerProfile: Profile = {
  profile_id: 'readylayer',
  tenant_id: 'readylayer',
  name: 'Readylayer Profile',
  description: 'Optimized for Readylayer infrastructure platform',
  plan_ids: ['developer', 'team', 'organization'],
  anomaly_thresholds: {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    usage_drop_threshold_pct: 30,  // More sensitive to usage drops
    refund_spike_threshold_pct: 5, // 5% of revenue
  },
  churn_thresholds: {
    ...DEFAULT_CHURN_THRESHOLDS,
    usage_drop_weight: 0.35,
    support_ticket_weight: 0.25,
  },
  alert_routing: {
    channels: ['slack'],
    severity_filter: ['medium', 'high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * AIAS profile - optimized for AIAS AI platform
 */
export const aiasProfile: Profile = {
  profile_id: 'aias',
  tenant_id: 'aias',
  name: 'AIAS Profile',
  description: 'Optimized for AIAS AI/ML platform',
  plan_ids: ['hobby', 'pro', 'scale'],
  anomaly_thresholds: {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    usage_drop_threshold_pct: 40,
    refund_spike_threshold_cents: 75000,
  },
  churn_thresholds: {
    ...DEFAULT_CHURN_THRESHOLDS,
    usage_drop_weight: 0.4,  // Heavy weight on usage for AI platform
    inactivity_weight: 0.15,
  },
  alert_routing: {
    channels: ['email', 'slack', 'webhook'],
    severity_filter: ['low', 'medium', 'high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * Keys profile - optimized for Keys authentication service
 */
export const keysProfile: Profile = {
  profile_id: 'keys',
  tenant_id: 'keys',
  name: 'Keys Profile',
  description: 'Optimized for Keys authentication/authorization service',
  plan_ids: ['free', 'starter', 'growth', 'enterprise'],
  anomaly_thresholds: {
    ...DEFAULT_ANOMALY_THRESHOLDS,
    duplicate_event_window_seconds: 180,
    payment_failure_spike_threshold: 0.15, // Very sensitive (15%)
  },
  churn_thresholds: {
    ...DEFAULT_CHURN_THRESHOLDS,
    payment_failure_weight: 0.25,
    support_ticket_weight: 0.3,  // High weight on support for auth issues
  },
  alert_routing: {
    channels: ['email', 'slack'],
    severity_filter: ['high', 'critical'],
  },
  redact_sensitive_data: true,
  version: '1.0.0',
};

/**
 * Get profile by ID
 */
export function getProfile(profileId: string): Profile {
  switch (profileId) {
    case 'base':
      return baseProfile;
    case 'jobforge':
      return jobforgeProfile;
    case 'settler':
      return settlerProfile;
    case 'readylayer':
      return readylayerProfile;
    case 'aias':
      return aiasProfile;
    case 'keys':
      return keysProfile;
    default:
      return baseProfile;
  }
}

/**
 * List all available profiles
 */
export function listProfiles(): Profile[] {
  return [
    baseProfile,
    jobforgeProfile,
    settlerProfile,
    readylayerProfile,
    aiasProfile,
    keysProfile,
  ];
}

/**
 * Merge custom thresholds with profile defaults
 */
export function mergeProfileWithOverrides(
  profile: Profile,
  overrides: Partial<Pick<Profile, 'anomaly_thresholds' | 'churn_thresholds'>>
): Profile {
  const merged: Profile = {
    ...profile,
    anomaly_thresholds: {
      ...profile.anomaly_thresholds,
      ...overrides.anomaly_thresholds,
    },
    churn_thresholds: {
      ...profile.churn_thresholds,
      ...overrides.churn_thresholds,
    },
  };

  const validated = ProfileSchema.safeParse(merged);
  if (!validated.success) {
    throw new Error(`Merged profile validation failed: ${validated.error.errors.map(e => e.message).join(', ')}`);
  }

  return validated.data;
}

/**
 * Validate a profile configuration
 */
export function validateProfile(profile: unknown): { valid: boolean; errors: string[] } {
  const result = ProfileSchema.safeParse(profile);
  
  if (result.success) {
    return { valid: true, errors: [] };
  }
  
  return {
    valid: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

/**
 * Serialize profile to JSON
 */
export function serializeProfile(profile: Profile): string {
  return JSON.stringify(profile, null, 2);
}
