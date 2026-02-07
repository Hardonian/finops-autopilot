/**
 * Runner Contract for ControlPlane integration
 *
 * Implements the standardized runner interface that ControlPlane can invoke.
 * Provides safe execution, evidence emission, and deterministic behavior.
 */

import { z } from 'zod';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { MODULE_ID, MODULE_VERSION, getHealthStatus } from './health/index.js';
import type { EvidencePacket, JobForgeReportEnvelope, JobRequestBundle } from './contracts/index.js';
import { createArtifactWriter, createLogger, wrapError, createErrorEnvelope } from './runner/index.js';
import { analyze, AnalyzeInputsSchema } from './jobforge/index.js';

// ============================================================================
// Runner Contract Schema
// ============================================================================

export const RunnerExecuteResultSchema = z.object({
  status: z.enum(['success', 'error', 'partial']),
  output: z.record(z.unknown()).optional(),
  evidence: z.array(z.unknown()).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
});

export const RunnerContractSchema = z.object({
  id: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  blastRadius: z.enum(['low', 'medium', 'high', 'critical']),
  execute: z.function()
    .args(z.record(z.unknown()))
    .returns(z.promise(RunnerExecuteResultSchema)),
});

export type RunnerExecuteResult = z.infer<typeof RunnerExecuteResultSchema>;
export type RunnerContract = z.infer<typeof RunnerContractSchema>;

// ============================================================================
// Runner Implementation
// ============================================================================

/**
 * Main runner implementation that ControlPlane can invoke
 */
class FinOpsRunner implements RunnerContract {
  readonly id = MODULE_ID;
  readonly version = MODULE_VERSION;
  readonly capabilities: string[];
  readonly blastRadius = 'medium' as const;

  constructor() {
    const health = getHealthStatus();
    this.capabilities = health.capabilities;
  }

  /**
   * Execute the runner with given inputs
   * Never hard-crashes - always returns a result envelope
   */
  async execute(inputs: Record<string, unknown>): Promise<RunnerExecuteResult> {
    const startedAt = new Date().toISOString();
    const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Create temporary artifact directory for this run
      const tempDir = resolve('.finops-runner', runId);
      mkdirSync(tempDir, { recursive: true });

      const aw = createArtifactWriter(tempDir);
      const log = createLogger({
        module: 'finops-runner',
        filePath: aw.logsPath,
        json: true,
      });

      log.info('runner.execute.start', 'Starting FinOps runner execution', {
        run_id: runId,
        inputs_count: Object.keys(inputs).length,
      });

      // Validate inputs against expected schema
      const validatedInputs = this.validateInputs(inputs, log) as any;

      // Execute the analysis pipeline
      const { jobRequestBundle, reportEnvelope } = analyze(validatedInputs, {
        stableOutput: true, // Always use stable output for runner
      });

      // Emit evidence packet
      const evidencePacket = this.createEvidencePacket(runId, validatedInputs as any, jobRequestBundle as any, reportEnvelope as any);

      // Write outputs
      const outputs = this.writeOutputs(aw as any, jobRequestBundle as any, reportEnvelope as any, evidencePacket as any);

      // Finalize artifacts
      aw.finalize({
        command: 'runner.execute',
        startedAt,
        exitCode: 0,
        idempotencyKey: `runner_${validatedInputs.tenant_id}_${validatedInputs.project_id}_${startedAt.slice(0, 10)}`,
        stats: {
          run_id: runId,
          job_requests: jobRequestBundle.requests.length,
          findings: reportEnvelope.findings.length,
        },
      });

      log.info('runner.execute.success', 'FinOps runner execution completed', {
        run_id: runId,
        job_requests: jobRequestBundle.requests.length,
        findings: reportEnvelope.findings.length,
      });

      return {
        status: 'success',
        output: outputs,
        evidence: [evidencePacket],
      };

    } catch (err) {
      // Never hard-crash - wrap all errors
      const errorEnvelope = wrapError(err);

      // Create minimal evidence packet for errors
      const errorEvidence = this.createErrorEvidencePacket(runId, inputs, errorEnvelope, startedAt);

      return {
        status: 'error',
        error: {
          code: errorEnvelope.code,
          message: errorEnvelope.userMessage,
          details: errorEnvelope.cause,
        },
        evidence: [errorEvidence],
      };
    }
  }

  private validateInputs(inputs: Record<string, unknown>, log: any): Record<string, unknown> {
    // Merge with default values for runner context
    const mergedInputs = {
      ...inputs,
      trace_id: inputs.trace_id || `runner_${Date.now()}`,
    };

    const parsed = AnalyzeInputsSchema.safeParse(mergedInputs);
    if (!parsed.success) {
      log.error('runner.validate.error', 'Input validation failed', {
        errors: parsed.error.errors,
      });
      throw createErrorEnvelope('VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join('; '));
    }

    return parsed.data;
  }

  private createEvidencePacket(runId: string, inputs: Record<string, unknown>, jobRequestBundle: JobRequestBundle, reportEnvelope: JobForgeReportEnvelope): EvidencePacket {
    const evidence: EvidencePacket = {
      packet_id: `evidence_${runId}`,
      tenant_id: inputs.tenant_id,
      project_id: inputs.project_id,
      created_at: new Date().toISOString(),
      source_module: MODULE_ID,
      event_type: 'runner_execution',
      severity: 'info',
      summary: `FinOps runner executed ${jobRequestBundle.requests.length} job requests with ${reportEnvelope.findings.length} findings`,
      evidence: [
        {
          label: 'input_tenant',
          value: inputs.tenant_id as string,
          source: 'runner_input',
        },
        {
          label: 'input_project',
          value: inputs.project_id as string,
          source: 'runner_input',
        },
        {
          label: 'job_requests_count',
          value: jobRequestBundle.requests.length,
          source: 'analysis_output',
        },
        {
          label: 'findings_count',
          value: reportEnvelope.findings.length,
          source: 'analysis_output',
        },
        {
          label: 'run_id',
          value: runId,
          source: 'runner_metadata',
        },
      ],
      related_entities: [
        {
          entity_type: 'tenant',
          entity_id: inputs.tenant_id,
        },
        {
          entity_type: 'project',
          entity_id: inputs.project_id,
        },
      ],
      hash: 'placeholder_hash', // Would compute actual hash
      metadata: {
        module_version: MODULE_VERSION,
        schema_version: '1.0.0',
        execution_mode: 'runner',
      },
    };

    return evidence;
  }

  private createErrorEvidencePacket(runId: string, inputs: Record<string, unknown>, errorEnvelope: unknown, startedAt: string): EvidencePacket {
    const errEnv = errorEnvelope as any;
    return {
      packet_id: `error_evidence_${runId}`,
      tenant_id: (inputs.tenant_id as string) || 'unknown',
      project_id: (inputs.project_id as string) || 'unknown',
      created_at: new Date().toISOString(),
      source_module: MODULE_ID,
      event_type: 'runner_execution_error',
      severity: 'high',
      summary: `FinOps runner execution failed: ${errEnv.userMessage}`,
      evidence: [
        {
          label: 'error_code',
          value: errEnv.code,
          source: 'error_envelope',
        },
        {
          label: 'error_message',
          value: errEnv.userMessage,
          source: 'error_envelope',
        },
        {
          label: 'started_at',
          value: startedAt,
          source: 'runner_metadata',
        },
        {
          label: 'run_id',
          value: runId,
          source: 'runner_metadata',
        },
      ],
      related_entities: [],
      hash: 'error_placeholder_hash',
      metadata: {
        module_version: MODULE_VERSION,
        error_context: 'runner_execution',
      },
    };
  }

  private writeOutputs(aw: unknown, jobRequestBundle: unknown, reportEnvelope: unknown, evidencePacket: EvidencePacket) {
    // Write evidence packet as JSON
    aw.writeEvidence('evidence_packet', evidencePacket);

    // Write evidence summary as markdown
    const markdownSummary = this.generateMarkdownSummary(evidencePacket, jobRequestBundle, reportEnvelope);
    aw.writeEvidence('evidence_summary', markdownSummary);

    return {
      evidence_packet: evidencePacket,
      evidence_summary: markdownSummary,
      job_request_bundle: jobRequestBundle,
      report_envelope: reportEnvelope,
      artifact_dir: aw.dir,
    };
  }

  private generateMarkdownSummary(evidence: EvidencePacket, jobRequestBundle: any, reportEnvelope: any): string {
    return `# FinOps Runner Execution Evidence

## Summary
${evidence.summary}

## Execution Details
- **Run ID**: ${evidence.evidence.find(e => e.label === 'run_id')?.value}
- **Tenant**: ${evidence.tenant_id}
- **Project**: ${evidence.project_id}
- **Timestamp**: ${evidence.created_at}
- **Module**: ${evidence.source_module}@${evidence.metadata?.module_version}

## Results
- **Job Requests**: ${jobRequestBundle.requests.length}
- **Findings**: ${reportEnvelope.findings.length}

## Evidence
${evidence.evidence.map(e => `- **${e.label}**: ${JSON.stringify(e.value)}`).join('\n')}

## Metadata
${Object.entries(evidence.metadata || {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}
`;
  }
}

// ============================================================================
// Demo Runner (deterministic, no external secrets)
// ============================================================================

/**
 * Demo runner that uses deterministic sample data
 */
class FinOpsDemoRunner extends FinOpsRunner {
  async execute(inputs: Record<string, unknown> = {}): Promise<RunnerExecuteResult> {
    // Override with demo inputs
    const demoInputs = {
      tenant_id: 'demo-tenant',
      project_id: 'demo-project',
      trace_id: 'demo-trace-001',
      ledger: this.getDemoLedger(),
      billing_events: this.getDemoEvents(),
      reference_date: new Date().toISOString(),
      ...inputs, // Allow overrides
    };

    return super.execute(demoInputs);
  }

  private getDemoLedger() {
    return {
      tenant_id: 'demo-tenant',
      project_id: 'demo-project',
      computed_at: new Date().toISOString(),
      customers: {
        'demo-customer-1': {
          customer_id: 'demo-customer-1',
          tenant_id: 'demo-tenant',
          project_id: 'demo-project',
          subscriptions: [
            {
              subscription_id: 'demo-sub-1',
              customer_id: 'demo-customer-1',
              plan_id: 'premium',
              status: 'active',
              current_period_start: '2024-01-01T00:00:00.000Z',
              current_period_end: '2024-02-01T00:00:00.000Z',
              mrr_cents: 2999,
              currency: 'USD',
              created_at: '2023-12-01T00:00:00.000Z',
              cancel_at_period_end: false,
            }
          ],
          total_mrr_cents: 2999,
          total_paid_cents: 2999,
          total_refunded_cents: 0,
          total_disputed_cents: 0,
          last_invoice_at: '2024-01-01T00:00:00.000Z',
          last_payment_at: '2024-01-01T00:00:00.000Z',
          payment_failure_count_30d: 0,
          updated_at: new Date().toISOString(),
        }
      },
      total_mrr_cents: 2999,
      total_customers: 1,
      active_subscriptions: 1,
      event_count: 5,
      version: '1.0.0',
    };
  }

  private getDemoEvents() {
    return [
      {
        tenant_id: 'demo-tenant',
        project_id: 'demo-project',
        event_id: 'demo-event-1',
        event_type: 'subscription_created',
        timestamp: '2023-12-01T00:00:00.000Z',
        customer_id: 'demo-customer-1',
        subscription_id: 'demo-sub-1',
        plan_id: 'premium',
        amount_cents: 2999,
        currency: 'USD',
        metadata: {},
        raw_payload: {},
      },
      {
        tenant_id: 'demo-tenant',
        project_id: 'demo-project',
        event_id: 'demo-event-2',
        event_type: 'invoice_paid',
        timestamp: '2024-01-01T00:00:00.000Z',
        customer_id: 'demo-customer-1',
        subscription_id: 'demo-sub-1',
        invoice_id: 'demo-invoice-1',
        amount_cents: 2999,
        currency: 'USD',
        metadata: {},
        raw_payload: {},
      },
    ];
  }
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create the standard FinOps runner instance
 */
export function createFinOpsRunner(): RunnerContract {
  return new FinOpsRunner();
}

/**
 * Create the demo runner instance (deterministic, no external deps)
 */
export function createFinOpsDemoRunner(): RunnerContract {
  return new FinOpsDemoRunner();
}

