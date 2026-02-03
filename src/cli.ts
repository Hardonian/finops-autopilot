#!/usr/bin/env node
/**
 * FinOps Autopilot CLI
 * 
 * Commands:
 * - finops ingest --events ./billing-events.json
 * - finops reconcile --normalized ./normalized.json
 * - finops anomalies --ledger ./ledger.json
 * - finops churn --inputs ./churn-inputs.json
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { ingestEvents, serializeEvents } from './ingest/index.js';
import { buildLedger, reconcileMrr } from './reconcile/index.js';
import { detectAnomalies } from './anomalies/index.js';
import { assessChurnRisk } from './churn/index.js';
import { getProfile } from './profiles/index.js';
import { 
  validateSafePath, 
  safeJsonParse, 
  validateTenantContext
} from './security/index.js';
import { getHealthStatus, getCapabilityMetadata } from './health/index.js';

import type { ChurnInputs, NormalizedEvent } from './contracts/index.js';
import { analyze, renderReport, AnalyzeInputsSchema } from './jobforge/index.js';
import { serializeCanonical } from './jobforge/deterministic.js';

const program = new Command();

program
  .name('finops')
  .description('FinOps Autopilot - Billing reconciliation and anomaly detection')
  .version('0.1.0');

// Ingest command
program
  .command('ingest')
  .description('Ingest and normalize billing events')
  .addHelpText('after', '\nExample:\n  finops ingest --events ./billing-events.json --tenant my-tenant --project my-project\n')
  .requiredOption('--events <path>', 'Path to billing events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--output <path>', 'Output file path')
  .option('--skip-validation', 'Skip validation and include invalid events', false)
  .action((options) => {
    try {
      // Validate tenant context
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        console.error(`Security Error: ${tenantValidation.error}`);
        process.exit(1);
      }

      // Validate path security
      const pathValidation = validateSafePath(options.events);
      if (!pathValidation.valid) {
        console.error(`Security Error: ${pathValidation.error}`);
        process.exit(1);
      }

      const eventsPath = resolve(options.events);
      if (!existsSync(eventsPath)) {
        console.error(`Error: Events file not found`);
        process.exit(1);
      }

      // Safe JSON parsing
      const fileContent = readFileSync(eventsPath, 'utf-8');
      const parseResult = safeJsonParse<unknown[]>(fileContent);
      if (!parseResult.success) {
        console.error(`Error: ${parseResult.error}`);
        process.exit(1);
      }

      const rawEvents = parseResult.data;
      
      if (!Array.isArray(rawEvents)) {
        console.error('Error: Events file must contain an array of events');
        process.exit(1);
      }

      const result = ingestEvents(rawEvents, {
        tenantId: options.tenant,
        projectId: options.project,
        skipValidation: options.skipValidation,
      });

      console.log(`\nIngestion Results:`);
      console.log(`  Total events: ${result.stats.total}`);
      console.log(`  Valid: ${result.stats.valid}`);
      console.log(`  Invalid: ${result.stats.invalid}`);
      console.log(`  By type:`, result.stats.byType);

      if (result.errors.length > 0) {
        console.log(`\n  Errors (${result.errors.length}):`);
        result.errors.slice(0, 5).forEach((err) => {
          console.log(`    [${err.index}] ${err.error}`);
        });
        if (result.errors.length > 5) {
          console.log(`    ... and ${result.errors.length - 5} more`);
        }
      }

      if (result.events.length > 0) {
        const output = serializeEvents(result.events);
        
        if (options.output) {
          const outputPath = resolve(options.output);
          writeFileSync(outputPath, output, 'utf-8');
          console.log(`\n  Written to: ${outputPath}`);
        } else {
          console.log(`\n  Output (first 1000 chars):`);
          console.log(output.slice(0, 1000) + (output.length > 1000 ? '...' : ''));
        }
      }
    } catch (err) {
      handleCliError(err);
    }
  });

// Reconcile command
program
  .command('reconcile')
  .description('Reconcile MRR from normalized events')
  .addHelpText('after', '\nExample:\n  finops reconcile --normalized ./normalized.json --tenant my-tenant --project my-project\n')
  .requiredOption('--normalized <path>', 'Path to normalized events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--period-start <date>', 'Period start (ISO 8601)', getFirstDayOfMonth())
  .option('--period-end <date>', 'Period end (ISO 8601)', getLastDayOfMonth())
  .option('--output <path>', 'Output file path')
  .action((options) => {
    try {
      const normalizedPath = resolve(options.normalized);
      if (!existsSync(normalizedPath)) {
        console.error(`Error: Normalized events file not found: ${normalizedPath}`);
        process.exit(1);
      }

      const events: NormalizedEvent[] = JSON.parse(readFileSync(normalizedPath, 'utf-8'));
      
      if (!Array.isArray(events)) {
        console.error('Error: Normalized events file must contain an array');
        process.exit(1);
      }

      const ledger = buildLedger(events, {
        tenantId: options.tenant,
        projectId: options.project,
        periodStart: options.periodStart,
        periodEnd: options.periodEnd,
      });

      const report = reconcileMrr(ledger, {
        tenantId: options.tenant,
        projectId: options.project,
        periodStart: options.periodStart,
        periodEnd: options.periodEnd,
      });

      console.log(`\nLedger Summary:`);
      console.log(`  Total MRR: $${(ledger.total_mrr_cents / 100).toFixed(2)}`);
      console.log(`  Customers: ${ledger.total_customers}`);
      console.log(`  Active subscriptions: ${ledger.active_subscriptions}`);
      console.log(`  Events processed: ${ledger.event_count}`);

      console.log(`\nReconciliation Report:`);
      console.log(`  Report ID: ${report.report_id}`);
      console.log(`  Expected MRR: $${(report.total_expected_mrr_cents / 100).toFixed(2)}`);
      console.log(`  Observed MRR: $${(report.total_observed_mrr_cents / 100).toFixed(2)}`);
      console.log(`  Difference: $${(report.total_difference_cents / 100).toFixed(2)}`);
      console.log(`  Balanced: ${report.is_balanced ? 'Yes' : 'No'}`);
      console.log(`  Report hash: ${report.report_hash.slice(0, 16)}...`);

      if (report.discrepancies.length > 0) {
        console.log(`\n  Discrepancies (${report.discrepancies.length}):`);
        report.discrepancies.slice(0, 5).forEach((d) => {
          console.log(`    - ${d.subscription_id}: $${(d.difference_cents / 100).toFixed(2)} (${d.reason})`);
        });
      }

      if (report.missing_events.length > 0) {
        console.log(`\n  Missing events detected: ${report.missing_events.length}`);
      }

      const output = JSON.stringify({ ledger, report }, null, 2);
      
      if (options.output) {
        const outputPath = resolve(options.output);
        writeFileSync(outputPath, output, 'utf-8');
        console.log(`\n  Written to: ${outputPath}`);
      }
    } catch (err) {
      handleCliError(err);
    }
  });

// Anomalies command
program
  .command('anomalies')
  .description('Detect anomalies in ledger data')
  .addHelpText('after', '\nExample:\n  finops anomalies --ledger ./ledger.json --tenant my-tenant --project my-project\n')
  .requiredOption('--ledger <path>', 'Path to ledger JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--profile <name>', 'Profile to use for thresholds', 'base')
  .option('--reference-date <date>', 'Reference date (ISO 8601)', new Date().toISOString())
  .option('--output <path>', 'Output file path')
  .action((options) => {
    try {
      const ledgerPath = resolve(options.ledger);
      if (!existsSync(ledgerPath)) {
        console.error(`Error: Ledger file not found: ${ledgerPath}`);
        process.exit(1);
      }

      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      
      // Load or use empty events array
      const events: NormalizedEvent[] = [];

      const profile = getProfile(options.profile);
      
      const result = detectAnomalies(events, ledger, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: options.referenceDate,
        profile,
      });

      console.log(`\nAnomaly Detection Results:`);
      console.log(`  Profile: ${profile.name}`);
      console.log(`  Total anomalies: ${result.stats.total}`);
      console.log(`  By severity:`, result.stats.bySeverity);
      console.log(`  By type:`, result.stats.byType);

      if (result.anomalies.length > 0) {
        console.log(`\n  Anomalies (top 10):`);
        result.anomalies
          .sort((a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0))
          .slice(0, 10)
          .forEach((a) => {
            console.log(`    [${a.severity.toUpperCase()}] ${a.anomaly_type}: ${a.description.slice(0, 60)}...`);
          });
      }

      const output = JSON.stringify(result, null, 2);
      
      if (options.output) {
        const outputPath = resolve(options.output);
        writeFileSync(outputPath, output, 'utf-8');
        console.log(`\n  Written to: ${outputPath}`);
      }
    } catch (err) {
      handleCliError(err);
    }
  });

// Churn command
program
  .command('churn')
  .description('Assess churn risk for customers')
  .addHelpText('after', '\nExample:\n  finops churn --inputs ./churn-inputs.json --tenant my-tenant --project my-project\n')
  .requiredOption('--inputs <path>', 'Path to churn inputs JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--profile <name>', 'Profile to use for thresholds', 'base')
  .option('--output <path>', 'Output file path')
  .action((options) => {
    try {
      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        console.error(`Error: Inputs file not found: ${inputsPath}`);
        process.exit(1);
      }

      const inputs: ChurnInputs = JSON.parse(readFileSync(inputsPath, 'utf-8'));
      
      const profile = getProfile(options.profile);
      
      const result = assessChurnRisk(inputs, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: inputs.reference_date,
        profile,
      });

      console.log(`\nChurn Risk Assessment:`);
      console.log(`  Profile: ${profile.name}`);
      console.log(`  Customers assessed: ${result.stats.totalAssessed}`);
      console.log(`  By risk level:`, result.stats.byLevel);
      console.log(`  Average risk score: ${result.stats.averageScore.toFixed(1)}/100`);

      if (result.risks.length > 0) {
        console.log(`\n  High/Critical Risk Customers (top 10):`);
        result.risks
          .filter((r) => r.risk_level === 'high' || r.risk_level === 'critical')
          .slice(0, 10)
          .forEach((r) => {
            console.log(`    [${r.risk_level.toUpperCase()}] ${r.customer_id}: ${r.risk_score}/100 - ${r.explanation.slice(0, 50)}...`);
          });
      }

      const output = JSON.stringify(result, null, 2);
      
      if (options.output) {
        const outputPath = resolve(options.output);
        writeFileSync(outputPath, output, 'utf-8');
        console.log(`\n  Written to: ${outputPath}`);
      }
    } catch (err) {
      handleCliError(err);
    }
  });

// Health check command
program
  .command('health')
  .description('Display module health status and capabilities')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const health = getHealthStatus();
      const capabilities = getCapabilityMetadata();
      
      if (options.json) {
        console.log(JSON.stringify({ health, capabilities }, null, 2));
      } else {
        console.log('\nHealth Status:');
        console.log(`  Module: ${health.module_id}@${health.module_version}`);
        console.log(`  Status: ${health.status}`);
        console.log(`  Timestamp: ${health.timestamp}`);
        console.log(`  Checks: contracts=${health.checks.contracts}, schemas=${health.checks.schemas}, profiles=${health.checks.profiles}`);
        console.log('\nCapabilities:');
        console.log(`  Job Types: ${capabilities.job_types.map(j => j.job_type).join(', ')}`);
        console.log(`  Input Formats: ${capabilities.input_formats.join(', ')}`);
        console.log(`  Output Formats: ${capabilities.output_formats.join(', ')}`);
        console.log(`  Features: ${capabilities.features.join(', ')}`);
        console.log(`\nDLQ Semantics:`);
        console.log(`  Enabled: ${capabilities.dlq_semantics.enabled}`);
        console.log(`  Max Attempts: ${capabilities.dlq_semantics.max_attempts}`);
        console.log(`  Backoff: ${capabilities.dlq_semantics.backoff_strategy}`);
      }
    } catch (err) {
      handleCliError(err);
    }
  });

// JobForge analyze command
program
  .command('analyze')
  .description('Generate JobForge request bundle and report (dry-run only)')
  .addHelpText('after', '\nExample:\n  finops analyze --inputs ./fixtures/jobforge/input.json --tenant my-tenant --project my-project --trace trace-1 --out ./out/jobforge --stable-output\n')
  .requiredOption('--inputs <path>', 'Path to analyze inputs JSON file')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--trace <id>', 'Trace ID')
  .requiredOption('--out <dir>', 'Output directory for JobForge artifacts')
  .option('--stable-output', 'Produce deterministic output for fixtures/docs', false)
  .option('--no-markdown', 'Skip writing report.md')
  .action((options) => {
    try {
      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        console.error(`Error: Inputs file not found: ${inputsPath}`);
        process.exit(1);
      }

      const rawInputs = JSON.parse(readFileSync(inputsPath, 'utf-8')) as Record<string, unknown>;
      const mergedInputs = {
        ...rawInputs,
        tenant_id: options.tenant,
        project_id: options.project,
        trace_id: options.trace,
      };

      const parsed = AnalyzeInputsSchema.safeParse(mergedInputs);
      if (!parsed.success) {
        console.error(`Validation error: ${parsed.error.errors.map((e) => e.message).join('; ')}`);
        process.exit(2);
      }

      const { jobRequestBundle, reportEnvelope } = analyze(parsed.data, {
        stableOutput: options.stableOutput,
      });

      const outputDir = resolve(options.out);
      mkdirSync(outputDir, { recursive: true });

      writeFileSync(resolve(outputDir, 'request-bundle.json'), serializeCanonical(jobRequestBundle), 'utf-8');
      writeFileSync(resolve(outputDir, 'report.json'), serializeCanonical(reportEnvelope), 'utf-8');

      if (options.markdown) {
        writeFileSync(resolve(outputDir, 'report.md'), renderReport(reportEnvelope, 'md'), 'utf-8');
      }

      console.log(`JobForge artifacts written to ${outputDir}`);
    } catch (err) {
      handleCliError(err);
    }
  });

// Helper functions
function getFirstDayOfMonth(): string {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function getLastDayOfMonth(): string {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

program.parse();

function handleCliError(err: unknown, exitCode = 1): void {
  const message = formatError(err);
  if (process.env.DEBUG && err instanceof Error) {
    console.error(err.stack);
  }
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message ?? 'Unknown error';
}
