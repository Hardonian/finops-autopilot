#!/usr/bin/env node
/**
 * FinOps Autopilot CLI — Standardised runner interface
 *
 * Commands:
 *   finops plan   --config <path> [--dry-run] [--out <dir>] [--json]
 *   finops run    --config <path> [--smoke]   [--out <dir>] [--json]
 *   finops ingest / reconcile / anomalies / churn / analyze / health
 *
 * Exit codes:
 *   0 — success
 *   2 — validation error (bad input, schema mismatch)
 *   3 — external dependency failure (IO, upstream)
 *   4 — unexpected bug
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
  validateTenantContext,
} from './security/index.js';
import { getHealthStatus, getCapabilityMetadata } from './health/index.js';
import type { ChurnInputs, NormalizedEvent } from './contracts/index.js';
import { analyze, renderReport, AnalyzeInputsSchema } from './jobforge/index.js';
import { serializeCanonical } from './jobforge/deterministic.js';

import {
  createArtifactWriter,
  buildIdempotencyKey,
  findPreviousRun,
  createLogger,
  createErrorEnvelope,
  wrapError,
  exitCodeFor,
  EXIT_SUCCESS,
  type StructuredLogger,
  type ArtifactWriter,
  type RunnerErrorEnvelope,
} from './runner/index.js';

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('finops')
  .description('FinOps Autopilot - Billing reconciliation and anomaly detection')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// plan — dry-run that produces artifacts without network writes
// ---------------------------------------------------------------------------

program
  .command('plan')
  .description('Dry-run: produce a plan and artifacts without side effects')
  .requiredOption('--config <path>', 'Path to runner config JSON file')
  .option('--dry-run', 'Alias (plan is always dry-run)', true)
  .option('--out <dir>', 'Output directory', '.')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    const startedAt = new Date().toISOString();
    const base = resolve(options.out);
    const aw = createArtifactWriter(base);
    const log = createLogger({
      module: 'finops',
      filePath: aw.logsPath,
      json: options.json,
    });

    try {
      const config = loadConfig(options.config, log);
      const idemKey = buildIdempotencyKey(['plan', config.tenant_id, config.project_id, startedAt.slice(0, 10)]);

      log.info('plan.start', `Planning for ${config.tenant_id}/${config.project_id}`, { config: configSummary(config) });

      // Run each module as dry-run (read-only analysis)
      const steps = planSteps(config, log, aw);

      const summary = aw.finalize({
        command: 'plan',
        startedAt,
        exitCode: EXIT_SUCCESS,
        idempotencyKey: idemKey,
        stats: { steps: steps.length, modules: steps.map((s) => s.module) },
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      } else {
        console.log(`\nPlan complete — ${steps.length} step(s)`);
        for (const s of steps) {
          console.log(`  [${s.status}] ${s.module}: ${s.description}`);
        }
        console.log(`\nArtifacts: ${aw.dir}`);
      }

      process.exit(EXIT_SUCCESS);
    } catch (err) {
      handleError(err, 'plan', startedAt, aw, log, options.json);
    }
  });

// ---------------------------------------------------------------------------
// run — execute (with --smoke for quick validation)
// ---------------------------------------------------------------------------

program
  .command('run')
  .description('Execute runner (use --smoke for quick validation)')
  .requiredOption('--config <path>', 'Path to runner config JSON file')
  .option('--smoke', 'Smoke-test mode: use minimal sample data', false)
  .option('--dry-run', 'Dry-run: skip external writes', false)
  .option('--out <dir>', 'Output directory', '.')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    const startedAt = new Date().toISOString();
    const base = resolve(options.out);
    const aw = createArtifactWriter(base);
    const log = createLogger({
      module: 'finops',
      filePath: aw.logsPath,
      json: options.json,
    });

    try {
      const config = options.smoke ? smokeConfig() : loadConfig(options.config, log);
      const idemKey = buildIdempotencyKey([
        'run',
        config.tenant_id,
        config.project_id,
        options.smoke ? 'smoke' : startedAt.slice(0, 10),
      ]);

      // Replay detection
      if (!options.smoke) {
        const prev = findPreviousRun(base, idemKey);
        if (prev) {
          log.info('run.replay', `Replaying previous run ${prev.run_id}`, { previous_run_id: prev.run_id });
          if (options.json) {
            process.stdout.write(JSON.stringify(prev, null, 2) + '\n');
          } else {
            console.log(`\nReplay: previous successful run found (${prev.run_id})`);
            console.log(`Artifacts: ${prev.artifact_dir}`);
          }
          process.exit(EXIT_SUCCESS);
        }
      }

      log.info('run.start', `Running for ${config.tenant_id}/${config.project_id}`, {
        smoke: options.smoke,
        dryRun: options.dryRun,
      });

      const steps = executeSteps(config, log, aw, { dryRun: options.dryRun });

      const summary = aw.finalize({
        command: options.smoke ? 'run --smoke' : 'run',
        startedAt,
        exitCode: EXIT_SUCCESS,
        idempotencyKey: idemKey,
        stats: { steps: steps.length, modules: steps.map((s) => s.module) },
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      } else {
        console.log(`\nRun complete — ${steps.length} step(s)`);
        for (const s of steps) {
          console.log(`  [${s.status}] ${s.module}: ${s.description}`);
        }
        console.log(`\nArtifacts: ${aw.dir}`);
      }

      process.exit(EXIT_SUCCESS);
    } catch (err) {
      handleError(err, 'run', startedAt, aw, log, options.json);
    }
  });

// ---------------------------------------------------------------------------
// Existing sub-commands (preserved with unified exit codes)
// ---------------------------------------------------------------------------

program
  .command('ingest')
  .description('Ingest and normalize billing events')
  .addHelpText('after', '\nExample:\n  finops ingest --events ./billing-events.json --tenant my-tenant --project my-project\n')
  .requiredOption('--events <path>', 'Path to billing events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--output <path>', 'Output file path')
  .option('--out <path>', 'Output file path (alias for --output)')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--dry-run', 'Dry-run: validate but do not write output', false)
  .option('--skip-validation', 'Skip validation and include invalid events', false)
  .action((options) => {
    try {
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', tenantValidation.error ?? 'Invalid tenant context'), options.json);
      }

      const pathValidation = validateSafePath(options.events);
      if (!pathValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', pathValidation.error ?? 'Invalid path'), options.json);
      }

      const eventsPath = resolve(options.events);
      if (!existsSync(eventsPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', 'Events file not found'), options.json);
      }

      const fileContent = readFileSync(eventsPath, 'utf-8');
      const parseResult = safeJsonParse<unknown[]>(fileContent);
      if (!parseResult.success) {
        exitWithEnvelope(createErrorEnvelope('VALIDATION_ERROR', parseResult.error ?? 'JSON parse error'), options.json);
      }

      const rawEvents = parseResult.data;
      if (!Array.isArray(rawEvents)) {
        exitWithEnvelope(createErrorEnvelope('VALIDATION_ERROR', 'Events file must contain an array'), options.json);
      }

      const result = ingestEvents(rawEvents as unknown[], {
        tenantId: options.tenant,
        projectId: options.project,
        skipValidation: options.skipValidation,
      });

      const outputData = {
        stats: result.stats,
        errors: result.errors.slice(0, 20),
        event_count: result.events.length,
      };

      if (options.json) {
        process.stdout.write(JSON.stringify(outputData, null, 2) + '\n');
      } else {
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
      }

      if (!options.dryRun && result.events.length > 0) {
        const outputPath = options.output ?? options.out;
        if (outputPath) {
          writeFileSync(resolve(outputPath), serializeEvents(result.events), 'utf-8');
          if (!options.json) console.log(`\n  Written to: ${resolve(outputPath)}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

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
  .option('--out <path>', 'Output file path (alias)')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--dry-run', 'Dry-run: validate but do not write output', false)
  .action((options) => {
    try {
      const normalizedPath = resolve(options.normalized);
      if (!existsSync(normalizedPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', `Normalized events file not found: ${normalizedPath}`), options.json);
      }

      const events: NormalizedEvent[] = JSON.parse(readFileSync(normalizedPath, 'utf-8'));

      if (!Array.isArray(events)) {
        exitWithEnvelope(createErrorEnvelope('VALIDATION_ERROR', 'Normalized events file must contain an array'), options.json);
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

      if (options.json) {
        process.stdout.write(JSON.stringify({ ledger, report }, null, 2) + '\n');
      } else {
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
      }

      if (!options.dryRun) {
        const outputPath = options.output ?? options.out;
        if (outputPath) {
          writeFileSync(resolve(outputPath), JSON.stringify({ ledger, report }, null, 2), 'utf-8');
          if (!options.json) console.log(`\n  Written to: ${resolve(outputPath)}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

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
  .option('--out <path>', 'Output file path (alias)')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--dry-run', 'Dry-run: validate but do not write output', false)
  .action((options) => {
    try {
      const ledgerPath = resolve(options.ledger);
      if (!existsSync(ledgerPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', `Ledger file not found: ${ledgerPath}`), options.json);
      }

      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      const events: NormalizedEvent[] = [];
      const profile = getProfile(options.profile);

      const result = detectAnomalies(events, ledger, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: options.referenceDate,
        profile,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
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
      }

      if (!options.dryRun) {
        const outputPath = options.output ?? options.out;
        if (outputPath) {
          writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2), 'utf-8');
          if (!options.json) console.log(`\n  Written to: ${resolve(outputPath)}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

program
  .command('churn')
  .description('Assess churn risk for customers')
  .addHelpText('after', '\nExample:\n  finops churn --inputs ./churn-inputs.json --tenant my-tenant --project my-project\n')
  .requiredOption('--inputs <path>', 'Path to churn inputs JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--profile <name>', 'Profile to use for thresholds', 'base')
  .option('--output <path>', 'Output file path')
  .option('--out <path>', 'Output file path (alias)')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--dry-run', 'Dry-run: validate but do not write output', false)
  .action((options) => {
    try {
      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', `Inputs file not found: ${inputsPath}`), options.json);
      }

      const inputs: ChurnInputs = JSON.parse(readFileSync(inputsPath, 'utf-8'));
      const profile = getProfile(options.profile);

      const result = assessChurnRisk(inputs, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: inputs.reference_date,
        profile,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
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
      }

      if (!options.dryRun) {
        const outputPath = options.output ?? options.out;
        if (outputPath) {
          writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2), 'utf-8');
          if (!options.json) console.log(`\n  Written to: ${resolve(outputPath)}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

program
  .command('health')
  .description('Display module health status and capabilities')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const health = getHealthStatus();
      const capabilities = getCapabilityMetadata();

      if (options.json) {
        process.stdout.write(JSON.stringify({ health, capabilities }, null, 2) + '\n');
      } else {
        console.log('\nHealth Status:');
        console.log(`  Module: ${health.module_id}@${health.module_version}`);
        console.log(`  Status: ${health.status}`);
        console.log(`  Timestamp: ${health.timestamp}`);
        console.log(`  Checks: contracts=${health.checks.contracts}, schemas=${health.checks.schemas}, profiles=${health.checks.profiles}`);
        console.log('\nCapabilities:');
        console.log(`  Job Types: ${capabilities.job_types.map((j) => j.job_type).join(', ')}`);
        console.log(`  Input Formats: ${capabilities.input_formats.join(', ')}`);
        console.log(`  Output Formats: ${capabilities.output_formats.join(', ')}`);
        console.log(`  Features: ${capabilities.features.join(', ')}`);
        console.log(`\nDLQ Semantics:`);
        console.log(`  Enabled: ${capabilities.dlq_semantics.enabled}`);
        console.log(`  Max Attempts: ${capabilities.dlq_semantics.max_attempts}`);
        console.log(`  Backoff: ${capabilities.dlq_semantics.backoff_strategy}`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

program
  .command('analyze')
  .description('Generate JobForge request bundle and report (dry-run only)')
  .addHelpText('after', '\nExample:\n  finops analyze --inputs ./fixtures/jobforge/input.json --tenant my-tenant --project my-project --trace trace-1 --out ./out/jobforge --stable-output\n')
  .requiredOption('--inputs <path>', 'Path to analyze inputs JSON file')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--trace <id>', 'Trace ID')
  .requiredOption('--out <dir>', 'Output directory for JobForge artifacts')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--stable-output', 'Produce deterministic output for fixtures/docs', false)
  .option('--no-markdown', 'Skip writing report.md')
  .action((options) => {
    try {
      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', `Inputs file not found: ${inputsPath}`), options.json);
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
        exitWithEnvelope(
          createErrorEnvelope('VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join('; ')),
          options.json,
        );
        return; // unreachable, but satisfies TS narrowing
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

      if (options.json) {
        process.stdout.write(JSON.stringify({ output_dir: outputDir, files: ['request-bundle.json', 'report.json'] }, null, 2) + '\n');
      } else {
        console.log(`JobForge artifacts written to ${outputDir}`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface RunnerConfig {
  tenant_id: string;
  project_id: string;
  profile: string;
  events_path?: string;
  normalized_path?: string;
  ledger_path?: string;
  churn_inputs_path?: string;
  period_start?: string;
  period_end?: string;
}

function loadConfig(configPath: string, log: StructuredLogger): RunnerConfig {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    log.error('config.load', `Config file not found: ${resolved}`);
    const env = createErrorEnvelope('NOT_FOUND', `Config file not found: ${resolved}`);
    exitWithEnvelope(env, false);
    throw new Error('unreachable'); // for TS flow
  }

  const raw = JSON.parse(readFileSync(resolved, 'utf-8')) as RunnerConfig;

  if (!raw.tenant_id || !raw.project_id) {
    const env = createErrorEnvelope('VALIDATION_ERROR', 'Config must include tenant_id and project_id');
    exitWithEnvelope(env, false);
    throw new Error('unreachable');
  }

  log.info('config.loaded', `Config loaded for ${raw.tenant_id}/${raw.project_id}`);
  return { ...raw, profile: raw.profile ?? 'base' };
}

function smokeConfig(): RunnerConfig {
  return {
    tenant_id: 'smoke-tenant',
    project_id: 'smoke-project',
    profile: 'base',
  };
}

function configSummary(config: RunnerConfig): Record<string, unknown> {
  return {
    tenant_id: config.tenant_id,
    project_id: config.project_id,
    profile: config.profile,
    has_events: !!config.events_path,
    has_normalized: !!config.normalized_path,
    has_ledger: !!config.ledger_path,
    has_churn: !!config.churn_inputs_path,
  };
}

// ---------------------------------------------------------------------------
// Plan / Run step orchestration
// ---------------------------------------------------------------------------

interface StepResult {
  module: string;
  status: 'ok' | 'skip' | 'error';
  description: string;
}

function planSteps(config: RunnerConfig, log: StructuredLogger, aw: ArtifactWriter): StepResult[] {
  const steps: StepResult[] = [];
  const profile = getProfile(config.profile);

  // Health check
  const health = getHealthStatus();
  aw.writeEvidence('health', health);
  steps.push({ module: 'health', status: 'ok', description: `Module ${health.status}` });
  log.info('plan.health', `Health: ${health.status}`);

  // Ingest (if events provided)
  if (config.events_path && existsSync(resolve(config.events_path))) {
    const fileContent = readFileSync(resolve(config.events_path), 'utf-8');
    const parseResult = safeJsonParse<unknown[]>(fileContent);
    if (parseResult.success && Array.isArray(parseResult.data)) {
      const result = ingestEvents(parseResult.data, {
        tenantId: config.tenant_id,
        projectId: config.project_id,
      });
      aw.writeEvidence('ingest', { stats: result.stats, errors: result.errors.slice(0, 10) });
      steps.push({ module: 'ingest', status: 'ok', description: `${result.stats.valid}/${result.stats.total} events valid` });
      log.info('plan.ingest', `Ingested ${result.stats.total} events`);
    } else {
      steps.push({ module: 'ingest', status: 'error', description: 'Failed to parse events' });
    }
  } else {
    steps.push({ module: 'ingest', status: 'skip', description: 'No events_path in config' });
  }

  // Reconcile (if normalized provided)
  if (config.normalized_path && existsSync(resolve(config.normalized_path))) {
    const events: NormalizedEvent[] = JSON.parse(readFileSync(resolve(config.normalized_path), 'utf-8'));
    const ledger = buildLedger(events, {
      tenantId: config.tenant_id,
      projectId: config.project_id,
      periodStart: config.period_start ?? getFirstDayOfMonth(),
      periodEnd: config.period_end ?? getLastDayOfMonth(),
    });
    const report = reconcileMrr(ledger, {
      tenantId: config.tenant_id,
      projectId: config.project_id,
      periodStart: config.period_start ?? getFirstDayOfMonth(),
      periodEnd: config.period_end ?? getLastDayOfMonth(),
    });
    aw.writeEvidence('reconcile', { total_mrr_cents: ledger.total_mrr_cents, is_balanced: report.is_balanced });
    steps.push({ module: 'reconcile', status: 'ok', description: `MRR $${(ledger.total_mrr_cents / 100).toFixed(2)}, balanced=${report.is_balanced}` });
    log.info('plan.reconcile', `Reconciled: balanced=${report.is_balanced}`);
  } else {
    steps.push({ module: 'reconcile', status: 'skip', description: 'No normalized_path in config' });
  }

  // Anomalies (if ledger provided)
  if (config.ledger_path && existsSync(resolve(config.ledger_path))) {
    const ledger = JSON.parse(readFileSync(resolve(config.ledger_path), 'utf-8'));
    const result = detectAnomalies([], ledger, {
      tenantId: config.tenant_id,
      projectId: config.project_id,
      referenceDate: new Date().toISOString(),
      profile,
    });
    aw.writeEvidence('anomalies', { stats: result.stats });
    steps.push({ module: 'anomalies', status: 'ok', description: `${result.stats.total} anomalies detected` });
    log.info('plan.anomalies', `Anomalies: ${result.stats.total}`);
  } else {
    steps.push({ module: 'anomalies', status: 'skip', description: 'No ledger_path in config' });
  }

  // Churn (if inputs provided)
  if (config.churn_inputs_path && existsSync(resolve(config.churn_inputs_path))) {
    const inputs: ChurnInputs = JSON.parse(readFileSync(resolve(config.churn_inputs_path), 'utf-8'));
    const result = assessChurnRisk(inputs, {
      tenantId: config.tenant_id,
      projectId: config.project_id,
      referenceDate: inputs.reference_date,
      profile,
    });
    aw.writeEvidence('churn', { stats: result.stats });
    steps.push({ module: 'churn', status: 'ok', description: `${result.stats.totalAssessed} customers assessed` });
    log.info('plan.churn', `Churn: ${result.stats.totalAssessed} assessed`);
  } else {
    steps.push({ module: 'churn', status: 'skip', description: 'No churn_inputs_path in config' });
  }

  return steps;
}

function executeSteps(
  config: RunnerConfig,
  log: StructuredLogger,
  aw: ArtifactWriter,
  _opts: { dryRun: boolean },
): StepResult[] {
  // For now, run uses the same pipeline as plan. When external writes
  // are added (webhooks, API calls) they should be gated by _opts.dryRun.
  return planSteps(config, log, aw);
}

// ---------------------------------------------------------------------------
// Error handling helpers
// ---------------------------------------------------------------------------

function exitWithEnvelope(envelope: RunnerErrorEnvelope, json?: boolean): never {
  if (json) {
    process.stderr.write(JSON.stringify({ error: envelope }, null, 2) + '\n');
  } else {
    console.error(`Error [${envelope.code}]: ${envelope.userMessage}`);
    if (process.env.DEBUG && envelope.cause) {
      console.error(`  cause: ${envelope.cause}`);
    }
  }
  process.exit(exitCodeFor(envelope.code as import('./runner/errors.js').ErrorCode));
}

function handleError(
  err: unknown,
  command: string,
  startedAt: string,
  aw: ArtifactWriter,
  log: StructuredLogger,
  json?: boolean,
): never {
  const envelope = wrapError(err);
  log.error(`${command}.error`, envelope.userMessage, { code: envelope.code });

  aw.finalize({
    command,
    startedAt,
    exitCode: exitCodeFor(envelope.code as import('./runner/errors.js').ErrorCode),
    idempotencyKey: '',
    error: envelope,
  });

  exitWithEnvelope(envelope, json);
}

function handleCliError(err: unknown, json?: boolean): never {
  const envelope = wrapError(err);
  exitWithEnvelope(envelope, json);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

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
