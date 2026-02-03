import { describe, expect, it } from 'vitest';
import {
  validateSafePath,
  safeJsonParse,
  validateTenantContext,
  sanitizeForLog,
  createSafeError,
} from '../security/index.js';

describe('Security utilities', () => {
  describe('validateSafePath', () => {
    it('accepts safe relative paths', () => {
      const result = validateSafePath('./data/events.json');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('./data/events.json');
    });

    it('rejects paths with traversal sequences', () => {
      const result = validateSafePath('../../../etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('traversal');
    });

    it('rejects absolute paths', () => {
      const result = validateSafePath('/etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Absolute');
    });

    it('rejects paths with null bytes', () => {
      const result = validateSafePath('./data\0/events.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('null bytes');
    });

    it('accepts Windows-style relative paths', () => {
      const result = validateSafePath('.\\data\\events.json');
      expect(result.valid).toBe(true);
    });
  });

  describe('safeJsonParse', () => {
    it('parses valid JSON', () => {
      const result = safeJsonParse<{ key: string }>('{"key": "value"}');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('rejects invalid JSON', () => {
      const result = safeJsonParse('not json');
      expect(result.success).toBe(false);
      expect(result.error).toContain('JSON');
    });

    it('respects size limits', () => {
      const large = '{"key": "' + 'x'.repeat(100) + '"}';
      const result = safeJsonParse(large, { maxSize: 50 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('size');
    });
  });

  describe('validateTenantContext', () => {
    it('accepts valid tenant and project IDs', () => {
      const result = validateTenantContext('tenant-123', 'project_456');
      expect(result.valid).toBe(true);
    });

    it('rejects tenant IDs with invalid characters', () => {
      const result = validateTenantContext('tenant@123', 'project_456');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tenant_id');
    });

    it('rejects project IDs with invalid characters', () => {
      const result = validateTenantContext('tenant-123', 'project@456');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('project_id');
    });

    it('accepts uppercase letters in project IDs', () => {
      const result = validateTenantContext('tenant-123', 'PROJECT_456');
      expect(result.valid).toBe(false);
    });
  });

  describe('sanitizeForLog', () => {
    it('redacts API keys', () => {
      const input = 'api_key=sk-1234567890abcdef1234567890abcdef';
      const result = sanitizeForLog(input);
      expect(result).toContain('[REDACTED_KEY]');
      expect(result).not.toContain('sk-1234567890abcdef');
    });

    it('redacts tokens', () => {
      const input = 'auth_token=abc123def456ghi789jkl012mno345pq';
      const result = sanitizeForLog(input);
      expect(result).toContain('[REDACTED_TOKEN]');
      expect(result).not.toContain('abc123def456ghi789jkl012mno345pq');
    });

    it('redacts emails', () => {
      const input = 'user@example.com sent a request';
      const result = sanitizeForLog(input);
      expect(result).toContain('[REDACTED_EMAIL]');
      expect(result).not.toContain('user@example.com');
    });

    it('leaves safe content unchanged', () => {
      const input = 'Normal log message without secrets';
      const result = sanitizeForLog(input);
      expect(result).toBe(input);
    });
  });

  describe('createSafeError', () => {
    it('creates safe error from Error object', () => {
      const err = new Error('Something went wrong');
      const result = createSafeError(err, 'validation');
      expect(result.category).toBe('validation');
      expect(result.message).toBe('Something went wrong');
      expect(result.recoverable).toBe(true);
    });

    it('creates safe error from string', () => {
      const result = createSafeError('Error message', 'runtime');
      expect(result.category).toBe('runtime');
      expect(result.message).toBe('Error message');
      expect(result.recoverable).toBe(false);
    });

    it('sanitizes safe message', () => {
      const err = new Error('Error with api_key=secret1234567890123456');
      const result = createSafeError(err, 'security');
      expect(result.safeMessage).toContain('[REDACTED_KEY]');
      expect(result.safeMessage).not.toContain('secret1234567890123456');
    });
  });
});
