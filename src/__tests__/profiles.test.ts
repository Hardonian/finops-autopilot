import { describe, it, expect } from 'vitest';
import {
  baseProfile,
  jobforgeProfile,
  settlerProfile,
  getProfile,
  listProfiles,
  validateProfile,
} from '../profiles/index.js';

describe('Profiles', () => {
  describe('default profiles', () => {
    it('should have valid base profile', () => {
      const result = validateProfile(baseProfile);
      expect(result.valid).toBe(true);
      expect(baseProfile.profile_id).toBe('base');
    });

    it('should have valid jobforge profile', () => {
      const result = validateProfile(jobforgeProfile);
      expect(result.valid).toBe(true);
      expect(jobforgeProfile.profile_id).toBe('jobforge');
    });

    it('should have valid settler profile', () => {
      const result = validateProfile(settlerProfile);
      expect(result.valid).toBe(true);
      expect(settlerProfile.profile_id).toBe('settler');
    });
  });

  describe('profile selection', () => {
    it('should return base profile for unknown id', () => {
      const profile = getProfile('unknown');
      expect(profile.profile_id).toBe('base');
    });

    it('should return specific profile by id', () => {
      const profile = getProfile('jobforge');
      expect(profile.profile_id).toBe('jobforge');
    });

    it('should list all profiles', () => {
      const profiles = listProfiles();
      expect(profiles.length).toBeGreaterThanOrEqual(6);
      const ids = profiles.map((p) => p.profile_id);
      expect(ids).toContain('base');
      expect(ids).toContain('jobforge');
      expect(ids).toContain('settler');
    });
  });

  describe('validation', () => {
    it('should reject invalid profile', () => {
      const invalidProfile = {
        profile_id: 'invalid',
        // Missing required fields
      };

      const result = validateProfile(invalidProfile);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate thresholds are within bounds', () => {
      const validProfile = {
        profile_id: 'test',
        name: 'Test Profile',
        anomaly_thresholds: {
          refund_spike_threshold_pct: 150, // Invalid: > 100
        },
      };

      const result = validateProfile(validProfile);
      expect(result.valid).toBe(false);
    });
  });
});
