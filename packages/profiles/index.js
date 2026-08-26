const baseProfile = {
  profile_id: 'base',
  name: 'Base Profile',
  description: 'Default configuration suitable for most SaaS applications',
  anomaly_thresholds: {
    refund_spike_threshold_cents: 100000,
    refund_spike_threshold_pct: 10,
    dispute_spike_threshold: 5,
    payment_failure_spike_threshold: 0.25,
    duplicate_event_window_seconds: 300,
    usage_drop_threshold_pct: 50,
  },
  churn_thresholds: {
    payment_failure_weight: 0.3,
    usage_drop_weight: 0.25,
    support_ticket_weight: 0.2,
    plan_downgrade_weight: 0.15,
    inactivity_weight: 0.1,
    risk_score_low_threshold: 30,
    risk_score_medium_threshold: 50,
    risk_score_high_threshold: 75,
  },
  alert_routing: { channels: ['email'], severity_filter: ['high', 'critical'] },
  redact_sensitive_data: true,
  version: '1.0.0',
};

export { baseProfile };

export function createJobforgeProfile() {
  return {
    ...baseProfile,
    profile_id: 'jobforge',
    tenant_id: 'jobforge',
    name: 'JobForge Profile',
    description: 'Optimized for JobForge batch processing platform',
    plan_ids: ['starter', 'professional', 'enterprise'],
    anomaly_thresholds: {
      ...baseProfile.anomaly_thresholds,
      refund_spike_threshold_cents: 50000,
      payment_failure_spike_threshold: 0.2,
    },
    churn_thresholds: {
      ...baseProfile.churn_thresholds,
      payment_failure_weight: 0.35,
      usage_drop_weight: 0.3,
    },
    alert_routing: {
      channels: ['email', 'slack'],
      severity_filter: ['medium', 'high', 'critical'],
    },
  };
}

export function createSettlerProfile() {
  return {
    ...baseProfile,
    profile_id: 'settler',
    tenant_id: 'settler',
    name: 'Settler Profile',
    description: 'Optimized for Settler payment reconciliation service',
    plan_ids: ['basic', 'business', 'enterprise'],
    anomaly_thresholds: {
      ...baseProfile.anomaly_thresholds,
      refund_spike_threshold_cents: 25000,
      dispute_spike_threshold: 3,
      duplicate_event_window_seconds: 60,
    },
    churn_thresholds: {
      ...baseProfile.churn_thresholds,
      payment_failure_weight: 0.4,
      risk_score_high_threshold: 70,
    },
    alert_routing: {
      channels: ['email', 'pagerduty'],
      severity_filter: ['high', 'critical'],
    },
  };
}

export function createReadyLayerProfile() {
  return {
    ...baseProfile,
    profile_id: 'readylayer',
    tenant_id: 'readylayer',
    name: 'Readylayer Profile',
    description: 'Optimized for Readylayer infrastructure platform',
    plan_ids: ['developer', 'team', 'organization'],
    anomaly_thresholds: {
      ...baseProfile.anomaly_thresholds,
      usage_drop_threshold_pct: 30,
      refund_spike_threshold_pct: 5,
    },
    churn_thresholds: {
      ...baseProfile.churn_thresholds,
      usage_drop_weight: 0.35,
      support_ticket_weight: 0.25,
    },
    alert_routing: {
      channels: ['slack'],
      severity_filter: ['medium', 'high', 'critical'],
    },
  };
}

export function createAIASProfile() {
  return {
    ...baseProfile,
    profile_id: 'aias',
    tenant_id: 'aias',
    name: 'AIAS Profile',
    description: 'Optimized for AIAS AI/ML platform',
    plan_ids: ['hobby', 'pro', 'scale'],
    anomaly_thresholds: {
      ...baseProfile.anomaly_thresholds,
      usage_drop_threshold_pct: 40,
      refund_spike_threshold_cents: 75000,
    },
    churn_thresholds: {
      ...baseProfile.churn_thresholds,
      usage_drop_weight: 0.4,
      inactivity_weight: 0.15,
    },
    alert_routing: {
      channels: ['email', 'slack', 'webhook'],
      severity_filter: ['low', 'medium', 'high', 'critical'],
    },
  };
}

export function createKeysProfile() {
  return {
    ...baseProfile,
    profile_id: 'keys',
    tenant_id: 'keys',
    name: 'Keys Profile',
    description: 'Optimized for Keys authentication/authorization service',
    plan_ids: ['free', 'starter', 'growth', 'enterprise'],
    anomaly_thresholds: {
      ...baseProfile.anomaly_thresholds,
      duplicate_event_window_seconds: 180,
      payment_failure_spike_threshold: 0.15,
    },
    churn_thresholds: {
      ...baseProfile.churn_thresholds,
      payment_failure_weight: 0.25,
      support_ticket_weight: 0.3,
    },
    alert_routing: {
      channels: ['email', 'slack'],
      severity_filter: ['high', 'critical'],
    },
  };
}

export function getProfile(profileId) {
  const profiles = listProfiles();
  return profiles.find((profile) => profile.profile_id === profileId) ?? baseProfile;
}

export function listProfiles() {
  return [
    baseProfile,
    createJobforgeProfile(),
    createSettlerProfile(),
    createReadyLayerProfile(),
    createAIASProfile(),
    createKeysProfile(),
  ];
}

export function mergeProfileWithOverlay(base, overlay = {}) {
  return {
    ...base,
    ...overlay,
    anomaly_thresholds: {
      ...(base.anomaly_thresholds ?? {}),
      ...(overlay.anomaly_thresholds ?? {}),
    },
    churn_thresholds: {
      ...(base.churn_thresholds ?? {}),
      ...(overlay.churn_thresholds ?? {}),
    },
  };
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return { valid: false, error: 'profile must be an object' };
  }
  if (!profile.profile_id || typeof profile.profile_id !== 'string') {
    return { valid: false, error: 'profile_id required and must be a string' };
  }
  if (!profile.name || typeof profile.name !== 'string') {
    return { valid: false, error: 'name required and must be a string' };
  }
  return { valid: true };
}

export function serializeProfile(profile) {
  return JSON.stringify(profile, null, 2);
}

export function getThreshold(profile, key, fallback = 0) {
  return profile?.anomaly_thresholds?.[key] ?? profile?.churn_thresholds?.[key] ?? fallback;
}

export function exceedsThreshold(value, threshold) {
  return value > threshold;
}
