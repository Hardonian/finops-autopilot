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
import { getHealthStatus } from './health/index.js';
import type { ChurnInputs, NormalizedEvent } from './contracts/index.js';
import { createFinOpsDemoRunner } from './runner-contract.js';

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

       console.log('Running FinOps demo...');

       const demoRunner = createFinOpsDemoRunner();
       const result = await demoRunner.execute({});

       if (options.json) {
         process.stdout.write(JSON.stringify(result, null, 2) + '\n');
       } else {
         if (result.status === 'success') {
           console.log(`\nDemo completed successfully!`);
           console.log(`Status: ${result.status}`);
           console.log(`Output directory: ${outputDir}`);

           // Write outputs to files
           if (result.output) {
             writeFileSync(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');

             if (result.evidence && result.evidence[0]) {
               writeFileSync(resolve(outputDir, 'evidence.json'), JSON.stringify(result.evidence[0], null, 2), 'utf-8');

               // Generate and write markdown summary
               const evidence = result.evidence[0];
               const markdownSummary = `# FinOps Demo Evidence

## Summary
${evidence.summary}

## Execution Details
- **Tenant**: ${evidence.tenant_id}
- **Project**: ${evidence.project_id}
- **Timestamp**: ${evidence.created_at}

## Results
${evidence.evidence.map(e => `- **${e.label}**: ${JSON.stringify(e.value)}`).join('\n')}

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
