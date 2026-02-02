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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ingestEvents, serializeEvents } from './ingest/index.js';
import { buildLedger, reconcileMrr } from './reconcile/index.js';
import { detectAnomalies } from './anomalies/index.js';
import { assessChurnRisk } from './churn/index.js';
import { getProfile } from './profiles/index.js';
import type { ChurnInputs, NormalizedEvent } from './contracts/index.js';

const program = new Command();

program
  .name('finops')
  .description('FinOps Autopilot - Billing reconciliation and anomaly detection')
  .version('0.1.0');

// Ingest command
program
  .command('ingest')
  .description('Ingest and normalize billing events')
  .requiredOption('--events <path>', 'Path to billing events JSON file')
  .option('--tenant <id>', 'Tenant ID', 'default')
  .option('--project <id>', 'Project ID', 'default')
  .option('--output <path>', 'Output file path')
  .option('--skip-validation', 'Skip validation and include invalid events', false)
  .action((options) => {
    try {
      const eventsPath = resolve(options.events);
      if (!existsSync(eventsPath)) {
        console.error(`Error: Events file not found: ${eventsPath}`);
        process.exit(1);
      }

      const rawEvents = JSON.parse(readFileSync(eventsPath, 'utf-8'));
      
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
      console.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Reconcile command
program
  .command('reconcile')
  .description('Reconcile MRR from normalized events')
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
      console.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Anomalies command
program
  .command('anomalies')
  .description('Detect anomalies in ledger data')
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
      console.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Churn command
program
  .command('churn')
  .description('Assess churn risk for customers')
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
      console.error(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
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
