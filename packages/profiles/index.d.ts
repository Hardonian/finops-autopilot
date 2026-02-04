export interface Profile {
  profile_id: string;
  [key: string]: unknown;
}

export const baseProfile: Profile;

export function createJobforgeProfile(): Profile;
export function createSettlerProfile(): Profile;
export function createReadyLayerProfile(): Profile;
export function createAIASProfile(): Profile;
export function createKeysProfile(): Profile;
export function getProfile(profileId: string): Profile;
export function listProfiles(): Profile[];
export function mergeProfileWithOverlay(base: Profile, overlay?: Profile): Profile;
export function validateProfile(profile: Profile): { valid: boolean; error?: string };
export function serializeProfile(profile: Profile): string;
export function getThreshold(profile: Profile, key: string, fallback?: number): number;
export function exceedsThreshold(value: number, threshold: number): boolean;
