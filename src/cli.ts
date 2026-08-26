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
import { ingestEvents, ingestAny, serializeEvents } from './ingest/index.js';
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
import type { ChurnInputs, NormalizedEvent, IngestFormat } from './contracts/index.js';
import { createFinOpsDemoRunner } from './runner-contract.js';
import { analyze, renderReport, AnalyzeInputsSchema } from './jobforge/index.js';
import { serializeCanonical } from './jobforge/deterministic.js';
import { generateCostSnapshot } from './cost-snapshot/index.js';

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
  .requiredOption('--events <path>', 'Path to billing events file (JSON, CSV, JSONL)')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--format <format>', 'Input format (json, csv, jsonl, stripe, aws_cur, gcp_billing)')
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
      const result = ingestAny(fileContent, {
        tenantId: options.tenant,
        projectId: options.project,
        format: options.format as IngestFormat,
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
        console.log(`  Duplicates: ${result.stats.duplicates}`);
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

// ---------------------------------------------------------------------------
// reconcile — build ledger + reconcile MRR
// ---------------------------------------------------------------------------

program
  .command('reconcile')
  .description('Build customer ledger and reconcile MRR')
  .addHelpText('after', '\nExample:\n  finops reconcile --normalized ./normalized.json --tenant my-tenant --project my-project\n')
  .requiredOption('--normalized <path>', 'Path to normalized events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--period-start <iso>', 'Reconciliation period start (ISO timestamp)')
  .option('--period-end <iso>', 'Reconciliation period end (ISO timestamp)')
  .option('--output <path>', 'Output file path for ledger/report')
  .option('--out <path>', 'Output file path (alias for --output)')
  .option('--json', 'Emit structured JSON to stdout')
  .option('--dry-run', 'Dry-run: validate but do not write output', false)
  .action((options) => {
    try {
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', tenantValidation.error ?? 'Invalid tenant context'), options.json);
      }

      const pathValidation = validateSafePath(options.normalized);
      if (!pathValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', pathValidation.error ?? 'Invalid path'), options.json);
      }

      const normalizedPath = resolve(options.normalized);
      if (!existsSync(normalizedPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', 'Normalized events file not found'), options.json);
      }

      const raw = JSON.parse(readFileSync(normalizedPath, 'utf-8'));
      const events: NormalizedEvent[] = Array.isArray(raw) ? raw : [];

      const periodStart = options.periodStart ?? (events[0]?.timestamp ?? getFirstDayOfMonth());
      const periodEnd = options.periodEnd ?? (events[events.length - 1]?.timestamp ?? getLastDayOfMonth());

      const ledger = buildLedger(events, {
        tenantId: options.tenant,
        projectId: options.project,
        periodStart,
        periodEnd,
      });

      const report = reconcileMrr(ledger, {
        tenantId: options.tenant,
        projectId: options.project,
        periodStart,
        periodEnd,
      }, events);

      const result = {
        ledger_summary: {
          total_mrr_cents: ledger.total_mrr_cents,
          total_customers: ledger.total_customers,
          active_subscriptions: ledger.active_subscriptions,
          event_count: ledger.event_count,
        },
        reconciliation: {
          is_balanced: report.is_balanced,
          total_expected_mrr_cents: report.total_expected_mrr_cents,
          total_observed_mrr_cents: report.total_observed_mrr_cents,
          total_difference_cents: report.total_difference_cents,
          discrepancy_count: report.discrepancies.length,
          waterfall: report.waterfall,
          remediation_playbook: report.remediation_playbook,
        },
        report,
      };

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(`\nReconciliation Results for ${options.tenant}/${options.project}:`);
        console.log(`  Total MRR: $${(ledger.total_mrr_cents / 100).toFixed(2)}`);
        console.log(`  Customers: ${ledger.total_customers} (Active Subscriptions: ${ledger.active_subscriptions})`);
        console.log(`  Balanced: ${report.is_balanced ? 'YES' : 'NO'}`);
        console.log(`  Discrepancies: ${report.discrepancies.length}`);

        if (report.waterfall) {
          console.log(`\n  MRR Waterfall:`);
          console.log(`    Starting MRR:    $${(report.waterfall.starting_mrr_cents / 100).toFixed(2)}`);
          console.log(`    + New MRR:       $${(report.waterfall.new_mrr_cents / 100).toFixed(2)}`);
          console.log(`    + Expansion:     $${(report.waterfall.expansion_mrr_cents / 100).toFixed(2)}`);
          console.log(`    + Reactivation:  $${(report.waterfall.reactivation_mrr_cents / 100).toFixed(2)}`);
          console.log(`    - Contraction:   $${(report.waterfall.contraction_mrr_cents / 100).toFixed(2)}`);
          console.log(`    - Churn:         $${(report.waterfall.churn_mrr_cents / 100).toFixed(2)}`);
          console.log(`    = Ending MRR:    $${(report.waterfall.ending_mrr_cents / 100).toFixed(2)}`);
        }

        if (report.remediation_playbook && report.remediation_playbook.length > 0) {
          console.log(`\n  Remediation Playbook:`);
          for (const item of report.remediation_playbook.slice(0, 5)) {
            console.log(`    • ${item}`);
          }
        }
      }

      if (!options.dryRun) {
        const outPath = options.output ?? options.out;
        if (outPath) {
          writeFileSync(resolve(outPath), JSON.stringify(result, null, 2), 'utf-8');
          if (!options.json) console.log(`\n  Written to: ${resolve(outPath)}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// anomalies — detect anomalies in billing data
// ---------------------------------------------------------------------------

program
  .command('anomalies')
  .description('Detect billing anomalies and operational irregularities')
  .addHelpText('after', '\nExample:\n  finops anomalies --ledger ./ledger.json --tenant my-tenant --project my-project\n')
  .requiredOption('--ledger <path>', 'Path to ledger state JSON file')
  .option('--events <path>', 'Path to normalized billing events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--profile <name>', 'Configuration profile (base, jobforge, settler, readylayer, aias, keys)', 'base')
  .option('--output <path>', 'Output file path')
  .option('--out <path>', 'Output file path (alias for --output)')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    try {
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', tenantValidation.error ?? 'Invalid tenant context'), options.json);
      }

      const ledgerPath = resolve(options.ledger);
      if (!existsSync(ledgerPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', 'Ledger file not found'), options.json);
      }

      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      let events: NormalizedEvent[] = [];
      if (options.events && existsSync(resolve(options.events))) {
        events = JSON.parse(readFileSync(resolve(options.events), 'utf-8'));
      }

      const profile = getProfile(options.profile);
      const result = detectAnomalies(events, ledger, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: new Date().toISOString(),
        profile,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(`\nAnomaly Detection Results (${options.profile} profile):`);
        console.log(`  Total anomalies detected: ${result.stats.total}`);
        console.log(`  By severity:`, result.stats.bySeverity);
        console.log(`  By type:`, result.stats.byType);

        if (result.anomalies.length > 0) {
          console.log(`\n  Top Anomalies:`);
          for (const a of result.anomalies.slice(0, 5)) {
            console.log(`    [${a.severity.toUpperCase()}] ${a.anomaly_type}: ${a.description}`);
            if (a.recommended_action) {
              console.log(`      → Action: ${a.recommended_action}`);
            }
          }
        }
      }

      const outPath = options.output ?? options.out;
      if (outPath) {
        writeFileSync(resolve(outPath), JSON.stringify(result, null, 2), 'utf-8');
        if (!options.json) console.log(`\n  Written to: ${resolve(outPath)}`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// churn — assess customer churn risk
// ---------------------------------------------------------------------------

program
  .command('churn')
  .description('Assess customer churn risk and compute revenue-at-risk')
  .addHelpText('after', '\nExample:\n  finops churn --inputs ./churn-inputs.json --tenant my-tenant --project my-project\n')
  .requiredOption('--inputs <path>', 'Path to churn inputs JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--profile <name>', 'Configuration profile (base, jobforge, settler, readylayer, aias, keys)', 'base')
  .option('--output <path>', 'Output file path')
  .option('--out <path>', 'Output file path (alias for --output)')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    try {
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', tenantValidation.error ?? 'Invalid tenant context'), options.json);
      }

      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', 'Churn inputs file not found'), options.json);
      }

      const inputs: ChurnInputs = JSON.parse(readFileSync(inputsPath, 'utf-8'));
      const profile = getProfile(options.profile);

      const result = assessChurnRisk(inputs, {
        tenantId: options.tenant,
        projectId: options.project,
        referenceDate: inputs.reference_date ?? new Date().toISOString(),
        profile,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(`\nChurn Risk Assessment (${options.profile} profile):`);
        console.log(`  Customers assessed: ${result.stats.totalAssessed}`);
        console.log(`  Average risk score: ${result.stats.averageScore.toFixed(1)}/100`);
        console.log(`  Risk distribution:`, result.stats.byLevel);

        if (result.revenue_at_risk) {
          console.log(`\n  Revenue At Risk:`);
          console.log(`    Total MRR:          $${(result.revenue_at_risk.total_mrr_cents / 100).toFixed(2)}`);
          console.log(`    At-Risk MRR:        $${(result.revenue_at_risk.at_risk_mrr_cents / 100).toFixed(2)} (${result.revenue_at_risk.at_risk_percentage}%)`);
          console.log(`    Critical-Risk MRR:   $${(result.revenue_at_risk.critical_risk_mrr_cents / 100).toFixed(2)}`);
        }

        if (result.risks.length > 0) {
          console.log(`\n  Top At-Risk Customers:`);
          for (const r of result.risks.slice(0, 5)) {
            console.log(`    Customer ${r.customer_id}: ${r.risk_score}/100 [${r.risk_level.toUpperCase()}]`);
            console.log(`      Reason: ${r.explanation}`);
            if (r.recommended_actions[0]) {
              console.log(`      Action: ${r.recommended_actions[0]}`);
            }
          }
        }
      }

      const outPath = options.output ?? options.out;
      if (outPath) {
        writeFileSync(resolve(outPath), JSON.stringify(result, null, 2), 'utf-8');
        if (!options.json) console.log(`\n  Written to: ${resolve(outPath)}`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// analyze — emit JobForge bundle + report
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('Analyze billing data and emit JobForge-compatible artifacts')
  .addHelpText('after', '\nExample:\n  finops analyze --inputs ./fixtures/jobforge/input.json --tenant t1 --project p1 --trace tr1 --out ./out/jobforge --stable-output\n')
  .requiredOption('--inputs <path>', 'Path to analyze inputs JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--trace <id>', 'Trace ID', 'trace-default')
  .option('--out <dir>', 'Output directory', './out/jobforge')
  .option('--stable-output', 'Produce deterministic stable hashes and timestamps', false)
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    try {
      const inputsPath = resolve(options.inputs);
      if (!existsSync(inputsPath)) {
        exitWithEnvelope(createErrorEnvelope('NOT_FOUND', 'Inputs file not found'), options.json);
      }

      const rawInput = JSON.parse(readFileSync(inputsPath, 'utf-8'));
      const inputs = AnalyzeInputsSchema.parse({
        ...rawInput,
        tenant_id: options.tenant,
        project_id: options.project,
        trace_id: options.trace,
      });

      const { jobRequestBundle, reportEnvelope } = analyze(inputs, {
        stableOutput: options.stableOutput,
      });

      const outDir = resolve(options.out);
      mkdirSync(outDir, { recursive: true });

      const bundleJson = serializeCanonical(jobRequestBundle);
      const reportJson = serializeCanonical(reportEnvelope);
      const reportMd = renderReport(reportEnvelope, 'md');

      writeFileSync(resolve(outDir, 'request-bundle.json'), bundleJson, 'utf-8');
      writeFileSync(resolve(outDir, 'report.json'), reportJson, 'utf-8');
      writeFileSync(resolve(outDir, 'report.md'), reportMd, 'utf-8');

      const result = {
        status: 'success',
        out_dir: outDir,
        job_requests_count: jobRequestBundle.requests.length,
        findings_count: reportEnvelope.findings.length,
        report_id: reportEnvelope.report_id,
        canonical_hash: reportEnvelope.canonicalization.canonical_hash,
      };

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(`\nJobForge Analysis Complete:`);
        console.log(`  Job Requests: ${jobRequestBundle.requests.length}`);
        console.log(`  Findings: ${reportEnvelope.findings.length}`);
        console.log(`  Hash: ${reportEnvelope.canonicalization.canonical_hash}`);
        console.log(`  Artifacts written to: ${outDir}`);
        console.log(`    - request-bundle.json`);
        console.log(`    - report.json`);
        console.log(`    - report.md`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// health — check health and capability discovery
// ---------------------------------------------------------------------------

program
  .command('health')
  .description('Check system health and runner maturity capabilities')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    try {
      const health = getHealthStatus();
      const capabilities = getCapabilityMetadata();
      const result = { health, capabilities };

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(`\nFinOps Autopilot Health: [${health.status.toUpperCase()}]`);
        console.log(`  Module: ${health.module_id}@${health.module_version}`);
        console.log(`  Contracts Check: ${health.checks.contracts ? 'PASS' : 'FAIL'}`);
        console.log(`  Schemas Check: ${health.checks.schemas ? 'PASS' : 'FAIL'}`);
        console.log(`  Profiles Check: ${health.checks.profiles ? 'PASS' : 'FAIL'}`);
        console.log(`\nCapabilities:`);
        for (const cap of health.capabilities) {
          console.log(`  ✓ ${cap}`);
        }
        console.log(`\nSupported JobForge Job Types:`);
        for (const jt of capabilities.job_types) {
          console.log(`  • ${jt.job_type}: ${jt.description}`);
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ---------------------------------------------------------------------------
// cost-snapshot — generate deterministic cost report
// ---------------------------------------------------------------------------

program
  .command('cost-snapshot')
  .description('Generate deterministic cost snapshot and forecast')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--period-start <iso>', 'Period start (ISO timestamp)')
  .requiredOption('--period-end <iso>', 'Period end (ISO timestamp)')
  .option('--events <path>', 'Path to billing events JSON file')
  .option('--ledger <path>', 'Path to ledger state JSON file')
  .option('--stable-output', 'Deterministic timestamps and hashes', false)
  .option('--output <path>', 'Output file path')
  .option('--out <path>', 'Output file path (alias for --output)')
  .option('--json', 'Emit structured JSON to stdout')
  .action((options) => {
    try {
      const tenantValidation = validateTenantContext(options.tenant, options.project);
      if (!tenantValidation.valid) {
        exitWithEnvelope(createErrorEnvelope('SECURITY_ERROR', tenantValidation.error ?? 'Invalid tenant context'), options.json);
      }

      let events = undefined;
      if (options.events && existsSync(resolve(options.events))) {
        events = JSON.parse(readFileSync(resolve(options.events), 'utf-8'));
      }

      let ledger = undefined;
      if (options.ledger && existsSync(resolve(options.ledger))) {
        ledger = JSON.parse(readFileSync(resolve(options.ledger), 'utf-8'));
      }

      const input = {
        tenant_id: options.tenant,
        project_id: options.project,
        period_start: options.periodStart,
        period_end: options.periodEnd,
        billing_events: events,
        ledger,
        include_breakdown: true,
        include_forecast: true,
      };

      const result = generateCostSnapshot(input, {
        tenantId: options.tenant,
        projectId: options.project,
        periodStart: options.periodStart,
        periodEnd: options.periodEnd,
        stableOutput: options.stableOutput,
      });

      if ('refusal' in result) {
        exitWithEnvelope(createErrorEnvelope('VALIDATION_ERROR', result.refusal), options.json);
      }

      if (options.json) {
        process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
      } else {
        console.log(`\nCost Snapshot (${options.periodStart} to ${options.periodEnd}):`);
        console.log(`  Total Cost: $${(result.report.total_cost_cents / 100).toFixed(2)} ${result.report.currency}`);
        console.log(`  Events: ${result.report.metadata.event_count} (Customers: ${result.report.metadata.customer_count})`);
        console.log(`  Cache Key: ${result.report.metadata.cache_key}`);
        console.log(`\n  Breakdown by Category:`);
        for (const [cat, cents] of Object.entries(result.report.breakdown.by_category)) {
          if (cents > 0) {
            console.log(`    • ${cat}: $${(cents / 100).toFixed(2)}`);
          }
        }
      }

      const outPath = options.output ?? options.out;
      if (outPath) {
        writeFileSync(resolve(outPath), JSON.stringify(result.report, null, 2), 'utf-8');
        if (!options.json) console.log(`\n  Written to: ${resolve(outPath)}`);
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

// ----------------------------------------------------------------------------
// demo — run deterministic demo with sample data
// ----------------------------------------------------------------------------

program
  .command('demo')
  .description('Run deterministic demo with sample data (no external secrets)')
  .option('--out <dir>', 'Output directory', './demo-output')
  .option('--json', 'Emit structured JSON to stdout')
  .action(async (options) => {
    try {
      const outputDir = resolve(options.out);
      mkdirSync(outputDir, { recursive: true });

      if (!options.json) console.log('Running FinOps demo...');

      const demoRunner = createFinOpsDemoRunner();
      const result = await demoRunner.execute({});

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        if (result.status === 'success') {
          console.log(`\nDemo completed successfully!`);
          console.log(`Status: ${result.status}`);
          console.log(`Output directory: ${outputDir}`);

          if (result.output) {
            writeFileSync(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');

            if (result.evidence && result.evidence[0]) {
              writeFileSync(resolve(outputDir, 'evidence.json'), JSON.stringify(result.evidence[0], null, 2), 'utf-8');

              const evidence = result.evidence[0] as Record<string, unknown>;
              const markdownSummary = `# FinOps Demo Evidence

## Summary
${evidence.summary}

## Execution Details
- **Tenant**: ${evidence.tenant_id}
- **Project**: ${evidence.project_id}
- **Timestamp**: ${evidence.created_at}

## Results
${(evidence.evidence as unknown[]).map((e: unknown) => {
  const entry = e as Record<string, unknown>;
  return `- **${entry.label}**: ${JSON.stringify(entry.value)}`;
}).join('\n')}

## Runner Contract
- **ID**: ${demoRunner.id}
- **Version**: ${demoRunner.version}
- **Capabilities**: ${demoRunner.capabilities.join(', ')}
- **Blast Radius**: ${demoRunner.blastRadius}
`;

              writeFileSync(resolve(outputDir, 'evidence.md'), markdownSummary, 'utf-8');
              console.log(`Evidence written to: ${resolve(outputDir, 'evidence.md')}`);
            }

            console.log(`Full results written to: ${resolve(outputDir, 'result.json')}`);
          }
        } else {
          console.log(`\nDemo failed with status: ${result.status}`);
          if (result.error) {
            console.log(`Error: ${result.error.message}`);
          }
        }
      }
    } catch (err) {
      handleCliError(err, options.json);
    }
  });

 program.parse();

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
