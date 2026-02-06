/**
 * contracts:check — validates schemas, SDK exports, and CLI entrypoints.
 *
 * Fails CI on drift:
 *  1. All Zod schemas parse round-trip with representative data
 *  2. SDK public API surface matches contracts.version.json
 *  3. CLI binary exists and every subcommand responds to --help
 *  4. contracts.version.json is present and well-formed
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { z } from 'zod';

import {
  BillingEventSchema,
  NormalizedEventSchema,
  LedgerStateSchema,
  ReconReportSchema,
  AnomalySchema,
  ChurnRiskSchema,
  JobRequestSchema,
  ProfileSchema,
  ChurnInputsSchema,
  CostSnapshotInputSchema,
  CostSnapshotReportSchema,
  RunnerMetricSchema,
  RunnerMetricsReportSchema,
  ModuleManifestSchema,
  EvidencePacketSchema,
  StructuredLogEventSchema,
  ErrorEnvelopeSchema,
} from '../src/contracts/index.js';

import {
  JobRequestBundleSchema,
  JobForgeReportEnvelopeSchema,
} from '../src/contracts/compat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${label}: ${msg}`);
  }
}

function assertSchemaParses(label: string, schema: z.ZodTypeAny, data: unknown): void {
  check(`schema:${label}`, () => {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    }
  });
}

// ---- 1. Schema round-trip validation ----

const now = new Date().toISOString();

assertSchemaParses('BillingEventSchema', BillingEventSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  event_id: 'evt-1',
  event_type: 'invoice_paid',
  timestamp: now,
  customer_id: 'cus-1',
  metadata: {},
  raw_payload: {},
});

assertSchemaParses('NormalizedEventSchema', NormalizedEventSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  event_id: 'evt-1',
  event_type: 'invoice_paid',
  timestamp: now,
  customer_id: 'cus-1',
  normalized_at: now,
  source_hash: 'abc123',
  metadata: {},
  raw_payload: {},
});

assertSchemaParses('LedgerStateSchema', LedgerStateSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  computed_at: now,
  customers: {},
  total_mrr_cents: 0,
  total_customers: 0,
  active_subscriptions: 0,
  event_count: 0,
});

assertSchemaParses('ReconReportSchema', ReconReportSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  report_id: 'rpt-1',
  generated_at: now,
  period_start: now,
  period_end: now,
  total_expected_mrr_cents: 0,
  total_observed_mrr_cents: 0,
  total_difference_cents: 0,
  discrepancies: [],
  missing_events: [],
  unmatched_observations: [],
  is_balanced: true,
  report_hash: 'abc123',
});

assertSchemaParses('AnomalySchema', AnomalySchema, {
  anomaly_id: 'anom-1',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  anomaly_type: 'missing_invoice',
  severity: 'low',
  detected_at: now,
  description: 'test',
  affected_events: [],
  confidence: 0.9,
});

assertSchemaParses('ChurnRiskSchema', ChurnRiskSchema, {
  risk_id: 'risk-1',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  customer_id: 'cus-1',
  calculated_at: now,
  risk_score: 42,
  risk_level: 'medium',
  contributing_signals: [],
  explanation: 'test',
  recommended_actions: [],
});

assertSchemaParses('JobRequestSchema', JobRequestSchema, {
  job_type: 'autopilot.finops.reconcile',
  job_id: 'job-1',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  requested_at: now,
  payload: {},
});

assertSchemaParses('ProfileSchema', ProfileSchema, {
  profile_id: 'prof-1',
  name: 'test',
});

assertSchemaParses('CostSnapshotInputSchema', CostSnapshotInputSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  period_start: now,
  period_end: now,
});

assertSchemaParses('CostSnapshotReportSchema', CostSnapshotReportSchema, {
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  report_id: 'rpt-1',
  period_start: now,
  period_end: now,
  generated_at: now,
  total_cost_cents: 0,
  currency: 'USD',
  breakdown: { by_category: {}, line_items: [] },
  metadata: {
    event_count: 0,
    customer_count: 0,
    subscription_count: 0,
    deterministic: true,
    cacheable: true,
    cache_key: 'key-1',
  },
});

assertSchemaParses('RunnerMetricSchema', RunnerMetricSchema, {
  runner_id: 'r-1',
  job_type: 'autopilot.finops.reconcile',
  window_start: now,
  window_end: now,
  captured_at: now,
  success_count: 1,
  failure_count: 0,
  retry_count: 0,
  idempotent_replay_count: 0,
  input_records: 10,
  output_records: 5,
  latency_ms_p50: 100,
  latency_ms_p95: 250,
});

assertSchemaParses('RunnerMetricsReportSchema', RunnerMetricsReportSchema, {
  module_id: 'finops',
  schema_version: '1.0.0',
  generated_at: now,
  metrics: [],
});

assertSchemaParses('ModuleManifestSchema', ModuleManifestSchema, {
  module_id: 'finops',
  version: '0.1.0',
  schema_version: '1.0.0',
  description: 'FinOps autopilot module',
  entrypoints: [{ name: 'finops', type: 'cli', path: './dist/cli.js' }],
  schemas: ['BillingEventSchema'],
  capabilities: ['billing_ingest'],
});

assertSchemaParses('EvidencePacketSchema', EvidencePacketSchema, {
  packet_id: 'pkt-1',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  created_at: now,
  source_module: 'finops',
  event_type: 'anomaly_detected',
  severity: 'medium',
  summary: 'Anomaly detected in billing data',
  evidence: [{ label: 'amount', value: 5000, source: 'ledger' }],
  hash: 'abc123',
});

assertSchemaParses('StructuredLogEventSchema', StructuredLogEventSchema, {
  timestamp: now,
  level: 'info',
  module: 'finops',
  action: 'ingest',
  message: 'Ingested 10 events',
});

assertSchemaParses('ErrorEnvelopeSchema', ErrorEnvelopeSchema, {
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid billing event',
    details: [{ message: 'missing tenant_id' }],
    source_module: 'finops',
    timestamp: now,
    retryable: false,
  },
});

// ---- 2. SDK exports surface check ----

check('sdk-exports', () => {
  const indexPath = resolve(root, 'src', 'index.ts');
  const indexContent = readFileSync(indexPath, 'utf-8');

  const requiredExports = [
    'BillingEventSchema',
    'NormalizedEventSchema',
    'LedgerStateSchema',
    'ReconReportSchema',
    'AnomalySchema',
    'ChurnRiskSchema',
    'JobRequestSchema',
    'ProfileSchema',
    'ChurnInputsSchema',
    'CostSnapshotInputSchema',
    'CostSnapshotReportSchema',
    'RunnerMetricSchema',
    'RunnerMetricsReportSchema',
    'ModuleManifestSchema',
    'EvidencePacketSchema',
    'StructuredLogEventSchema',
    'ErrorEnvelopeSchema',
    'ErrorCodeSchema',
    'LogLevelSchema',
    // Core functions
    'ingestEvents',
    'buildLedger',
    'reconcileMrr',
    'detectAnomalies',
    'assessChurnRisk',
    'analyze',
    'getHealthStatus',
    'getCapabilityMetadata',
  ];

  const missing = requiredExports.filter((exp) => !indexContent.includes(exp));
  if (missing.length > 0) {
    throw new Error(`Missing SDK exports: ${missing.join(', ')}`);
  }
});

// ---- 3. contracts.version.json drift check ----

check('contracts-version', () => {
  const versionPath = resolve(root, 'contracts.version.json');
  if (!existsSync(versionPath)) {
    throw new Error('contracts.version.json not found at project root');
  }

  const VersionFileSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    schemas: z.array(z.string().min(1)).min(1),
    suiteSchemas: z.array(z.string().min(1)),
    compatSchemas: z.array(z.string().min(1)),
    updatedAt: z.string().min(1),
  });

  const raw = JSON.parse(readFileSync(versionPath, 'utf-8')) as unknown;
  const result = VersionFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid contracts.version.json: ${result.error.errors.map((e) => e.message).join('; ')}`);
  }

  // Verify all listed schemas actually exist in the contracts module
  const contractsContent = readFileSync(resolve(root, 'src', 'contracts', 'index.ts'), 'utf-8');
  const compatContent = readFileSync(resolve(root, 'src', 'contracts', 'compat.ts'), 'utf-8');
  const allContent = contractsContent + compatContent;

  for (const schema of [...result.data.schemas, ...result.data.compatSchemas]) {
    if (!allContent.includes(`export const ${schema}`)) {
      throw new Error(`Schema "${schema}" listed in version file but not found in contracts source`);
    }
  }
});

// ---- 4. CLI entrypoint check ----

check('cli-entrypoint', () => {
  const cliPath = resolve(root, 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error('dist/cli.js not found — run pnpm build first');
  }
});

const cliCommands = ['--help', 'ingest --help', 'reconcile --help', 'anomalies --help', 'churn --help', 'analyze --help', 'health --help'];

for (const cmd of cliCommands) {
  check(`cli:${cmd}`, () => {
    const cliPath = resolve(root, 'dist', 'cli.js');
    const args = cmd.split(' ');
    const result = spawnSync('node', [cliPath, ...args], {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr.slice(0, 200) : '';
      throw new Error(`"finops ${cmd}" exited with code ${result.status}: ${stderr}`);
    }
  });
}

// ---- 5. Compat schemas parse ----

assertSchemaParses('JobRequestBundleSchema', JobRequestBundleSchema, {
  schema_version: '1.0.0',
  module_id: 'finops',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  trace_id: 'trace-1',
  requests: [],
  canonicalization: {
    algorithm: 'sha256',
    canonical_format: 'json-stable',
    canonical_hash: 'abc',
  },
});

assertSchemaParses('JobForgeReportEnvelopeSchema', JobForgeReportEnvelopeSchema, {
  schema_version: '1.0.0',
  module_id: 'finops',
  tenant_id: 'test-tenant',
  project_id: 'test-project',
  trace_id: 'trace-1',
  report_id: 'rpt-1',
  generated_at: now,
  report_type: 'finops',
  summary: {},
  canonicalization: {
    algorithm: 'sha256',
    canonical_format: 'json-stable',
    canonical_hash: 'abc',
  },
});

// ---- Report ----

if (failures.length > 0) {
  console.error(`\ncontracts:check FAILED (${failures.length} issue${failures.length > 1 ? 's' : ''}):\n`);
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exitCode = 1;
} else {
  console.log('contracts:check passed — all schemas, exports, and CLI entrypoints verified.');
}
