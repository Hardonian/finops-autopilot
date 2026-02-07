import { describe, expect, it } from 'vitest';
import { createFinOpsDemoRunner, createFinOpsRunner } from '../runner-contract.js';

describe('Runner Contract', () => {
  describe('createFinOpsDemoRunner', () => {
    it('creates a runner with correct contract properties', () => {
      const runner = createFinOpsDemoRunner();

      expect(runner.id).toBe('finops');
      expect(runner.version).toBe('0.1.0');
      expect(runner.capabilities).toContain('billing_ingest');
      expect(runner.blastRadius).toBe('medium');
      expect(typeof runner.execute).toBe('function');
    });

    it('executes successfully with demo data', async () => {
      const runner = createFinOpsDemoRunner();
      const result = await runner.execute({});

      expect(result.status).toBe('success');
      expect(result.output).toBeDefined();
      expect(result.evidence).toBeDefined();
      expect(result.evidence!.length).toBe(1);
      const evidence = result.evidence![0] as Record<string, unknown>;
      expect(evidence.tenant_id).toBe('custom-tenant');
      expect(evidence.project_id).toBe('custom-project');
    });

    it('never hard-crashes on errors', async () => {
      const runner = createFinOpsDemoRunner();

      // Pass invalid input that should cause validation error
      const result = await runner.execute({ tenant_id: null });

      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INTERNAL_ERROR'); // Zod validation throws, wrapped as internal error
      expect(result.evidence).toBeDefined();
    });
  });

  describe('createFinOpsRunner', () => {
    it('creates a runner with correct contract properties', () => {
      const runner = createFinOpsRunner();

      expect(runner.id).toBe('finops');
      expect(runner.version).toBe('0.1.0');
      expect(runner.capabilities).toContain('billing_ingest');
      expect(runner.blastRadius).toBe('medium');
      expect(typeof runner.execute).toBe('function');
    });
  });
});