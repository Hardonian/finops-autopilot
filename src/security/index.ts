/**
 * Security utilities for input validation and safe data handling
 * 
 * Non-negotiables:
 * - Never execute paths containing traversal sequences
 * - Never log sensitive data (PII, secrets)
 * - Always validate before parsing JSON
 * - Always sanitize error messages
 */

/**
 * Validates a file path to prevent directory traversal attacks
 * Only allows relative paths within the project directory
 */
export function validateSafePath(inputPath: string): { valid: boolean; sanitized?: string; error?: string } {
  // Check for null bytes
  if (inputPath.includes('\0')) {
    return { valid: false, error: 'Path contains null bytes' };
  }

  // Check for traversal sequences
  const normalized = inputPath.replace(/\\/g, '/');
  if (normalized.includes('../') || normalized.includes('..\\')) {
    return { valid: false, error: 'Path traversal detected' };
  }

  // Check for absolute paths that might escape project
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return { valid: false, error: 'Absolute paths not allowed' };
  }

  return { valid: true, sanitized: inputPath };
}

/**
 * Safely parses JSON with size and validation limits
 */
export function safeJsonParse<T>(
  input: string,
  options: { maxSize?: number; schema?: (obj: unknown) => obj is T } = {}
): { success: boolean; data?: T; error?: string } {
  const { maxSize = 10 * 1024 * 1024 } = options; // 10MB default

  // Check size limit
  if (input.length > maxSize) {
    return { success: false, error: `Input exceeds maximum size of ${maxSize} bytes` };
  }

  try {
    const parsed = JSON.parse(input) as T;
    return { success: true, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    return { success: false, error: `JSON parse error: ${message}` };
  }
}

/**
 * Sanitizes a string for safe logging (removes PII patterns)
 */
export function sanitizeForLog(input: string): string {
  // Remove patterns that look like secrets
  return input
    .replace(/[a-zA-Z0-9_]+_key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, '[REDACTED_KEY]')
    .replace(/[a-zA-Z0-9_]+_token\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, '[REDACTED_TOKEN]')
    .replace(/[a-zA-Z0-9_]+_secret\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi, '[REDACTED_SECRET]')
    .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED_SK]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
}

/**
 * Error taxonomy for consistent error handling
 */
export type ErrorCategory = 
  | 'validation'
  | 'io'
  | 'schema'
  | 'runtime'
  | 'security'
  | 'unknown';

export interface SafeError {
  category: ErrorCategory;
  message: string;
  safeMessage: string; // Sanitized version for logging
  recoverable: boolean;
}

/**
 * Creates a safe error envelope
 */
export function createSafeError(
  err: unknown,
  category: ErrorCategory = 'unknown'
): SafeError {
  const message = err instanceof Error ? err.message : String(err);
  
  return {
    category,
    message,
    safeMessage: sanitizeForLog(message),
    recoverable: category === 'validation' || category === 'schema',
  };
}

/**
 * Validates tenant and project IDs
 */
export function validateTenantContext(
  tenantId: string,
  projectId: string
): { valid: boolean; error?: string } {
  // Tenant ID: lowercase alphanumeric with hyphens
  if (!/^[a-z0-9-]+$/.test(tenantId)) {
    return { valid: false, error: 'Invalid tenant_id format (lowercase alphanumeric with hyphens only)' };
  }

  // Project ID: lowercase alphanumeric with hyphens/underscores
  if (!/^[a-z0-9-_]+$/.test(projectId)) {
    return { valid: false, error: 'Invalid project_id format (lowercase alphanumeric with hyphens/underscores only)' };
  }

  return { valid: true };
}
