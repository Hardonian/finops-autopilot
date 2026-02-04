const baseProfile = {
  profile_id: 'base',
  name: 'Base Profile',
  anomaly_thresholds: {},
  churn_thresholds: {},
  alert_routing: { channels: [], severity_filter: [] },
  redact_sensitive_data: true,
  version: '1.0.0',
};

export { baseProfile };

export function createJobforgeProfile() {
  return { ...baseProfile, profile_id: 'jobforge', name: 'JobForge Profile' };
}

export function createSettlerProfile() {
  return { ...baseProfile, profile_id: 'settler', name: 'Settler Profile' };
}

export function createReadyLayerProfile() {
  return { ...baseProfile, profile_id: 'readylayer', name: 'Readylayer Profile' };
}

export function createAIASProfile() {
  return { ...baseProfile, profile_id: 'aias', name: 'AIAS Profile' };
}

export function createKeysProfile() {
  return { ...baseProfile, profile_id: 'keys', name: 'Keys Profile' };
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
  if (!profile?.profile_id) {
    return { valid: false, error: 'profile_id required' };
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
