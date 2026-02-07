# finops-autopilot

A runnerless FinOps autopilot that ingests billing event exports, reconciles expected vs observed revenue, detects anomalies, and outputs explainable churn risk signals.

> **Boundary Statement**: This tool does not receive webhooks, run workers, or store secrets. It processes offline billing exports and outputs JobForge job requests for batch execution.

## Quickstart

```bash
# Clone and setup
git clone https://github.com/anomalyco/finops-autopilot.git
cd finops-autopilot
pnpm install

# Build and verify
pnpm run build
pnpm run verify:fast

# CLI usage
finops ingest --events ./billing-events.json --tenant my-tenant --project my-project
finops reconcile --normalized ./normalized.json --tenant my-tenant --project my-project
finops anomalies --ledger ./ledger.json --tenant my-tenant --project my-project
finops churn --inputs ./churn-inputs.json --tenant my-tenant --project my-project
finops analyze --inputs ./fixtures/jobforge/input.json --tenant my-tenant --project my-project --trace trace-1 --out ./out/jobforge
```

## JobForge Integration

This module emits JobForge-compatible request bundles and reports without executing any jobs. It never executes jobs; it only emits request bundles for JobForge to run.

```bash
finops analyze \
  --inputs ./fixtures/jobforge/input.json \
  --tenant tenant-demo \
  --project project-demo \
  --trace trace-demo \
  --out ./out/jobforge \
  --stable-output
```

Artifacts written:
- `request-bundle.json`
- `report.json`
- `report.md` (optional)

Each artifact is deterministic in `--stable-output` mode and includes `schema_version` `1.0.0` plus a canonical SHA-256 hash.

To export stable fixtures for integration tests:

```bash
pnpm run fixtures:export
```

Fixtures are written to `fixtures/jobforge/request-bundle.json`, `fixtures/jobforge/report.json`, and `fixtures/jobforge/report.md`.

See [`docs/jobforge-integration.md`](./docs/jobforge-integration.md) for the full integration contract and validation steps.
See [`docs/runner-maturity.md`](./docs/runner-maturity.md) for execution guarantees, metrics, and failure modes per runner.

## CLI Commands

| Command | Description |
| --- | --- |
| `finops plan` | Dry-run: produce plan and artifacts without side effects |
| `finops run` | Execute runner (use --smoke for quick validation) |
| `finops demo` | Run deterministic demo with sample data (no external secrets) |
| `finops ingest` | Normalize billing event exports |
| `finops reconcile` | Build ledger + reconcile MRR |
| `finops anomalies` | Detect anomalies from ledger data |
| `finops churn` | Assess churn risk signals |
| `finops analyze` | Emit JobForge bundle + report (dry-run) |
| `finops health` | Display module health status and capabilities |

## Runner Contract (ControlPlane Integration)

This module implements a standardized runner contract that ControlPlane can invoke directly:

```typescript
import { createFinOpsRunner } from 'finops-autopilot';

const runner = createFinOpsRunner();
const result = await runner.execute({
  tenant_id: 'my-tenant',
  project_id: 'my-project',
  // ... other inputs
});

// Result is always safe - never hard-crashes
if (result.status === 'success') {
  // Process successful output
  console.log('Runner executed successfully', result.output);
} else {
  // Handle error gracefully
  console.error('Runner failed:', result.error);
}

// Evidence packet always emitted for audit trails
console.log('Evidence:', result.evidence);
```

### Runner Contract Properties

- **id**: `'finops'`
- **version**: `'0.1.0'`
- **capabilities**: Array of supported capabilities
- **blastRadius**: `'medium'` (impact scope for safety)
- **execute()**: Main execution method that returns `{status, output, evidence, error?}`

### Safe Execution Guarantees

The `execute()` method never hard-crashes and always returns a structured result:
- **Success**: `{status: 'success', output: {...}, evidence: [...]}`
- **Error**: `{status: 'error', error: {code, message}, evidence: [...]}`
- **Partial**: `{status: 'partial', ...}` (for graceful degradation)

### Evidence Packets

Every execution emits structured evidence packets containing:
- Execution inputs, decisions, and outputs
- Timestamps and version information
- JSON format + short markdown summary
- Deterministic hashing for audit trails

### Demo Runner

For testing and development, use the deterministic demo runner:

```bash
# CLI demo
finops demo --out ./demo-output

# Programmatic demo
import { createFinOpsDemoRunner } from 'finops-autopilot';
const demoRunner = createFinOpsDemoRunner();
const result = await demoRunner.execute({});
```

## Architecture

```
src/
├── contracts/     # Zod schemas for all data types (BillingEvent, LedgerState, etc.)
├── ingest/        # Normalize billing events to canonical schema
├── reconcile/     # Compute MRR expectations vs observed
├── anomalies/     # Detect missing events, double charges, refund spikes
├── churn/         # Explainable churn risk heuristics
├── jobforge/      # Generate JobForge job requests
├── profiles/      # Base + per-app configuration profiles
└── cli.ts         # Command-line interface
```

## Non-Negotiables

1. **No secrets storage**: Only processes offline billing exports
2. **Multi-tenant safe**: All data requires `tenant_id` + `project_id`
3. **Deterministic**: Replayable, auditable outputs with stable hashing
4. **No financial advice**: Operational insights only
5. **Runnerless**: No workers, schedulers, or long-running processes
6. **OSS ready**: Docs, tests, CI, and examples included

## API Usage

```typescript
import { 
  ingestEvents, 
  buildLedger, 
  reconcileMrr,
  detectAnomalies,
  assessChurnRisk,
  createReconcileJob
} from 'finops-autopilot';

// Ingest billing events
const { events } = ingestEvents(rawEvents, { 
  tenantId: 'my-tenant', 
  projectId: 'my-project' 
});

// Build ledger and reconcile
const ledger = buildLedger(events, options);
const report = reconcileMrr(ledger, options);

// Detect anomalies
const { anomalies } = detectAnomalies(events, ledger, options);

// Assess churn risk
const { risks } = assessChurnRisk(churnInputs, options);

// Generate JobForge job request
const job = createReconcileJob(periodStart, periodEnd, eventsPath, options);
```

## Profiles

Pre-configured profiles available:
- `base` - Default configuration
- `jobforge` - Optimized for JobForge batch processing
- `settler` - Optimized for payment reconciliation
- `readylayer` - Optimized for infrastructure platform
- `aias` - Optimized for AI/ML platform
- `keys` - Optimized for authentication service

## Contract Kit

Contracts live in `src/contracts/` (Zod schemas) and `packages/contracts/` (shared workspace package). The contract kit includes:

- **Config schema** — `ProfileSchema` (anomaly/churn thresholds, alert routing)
- **Module manifest schema** — `ModuleManifestSchema` (module capabilities, entrypoints)
- **Evidence packet schema** — `EvidencePacketSchema` (structured audit evidence)
- **Structured log event schema** — `StructuredLogEventSchema` (typed log entries)
- **Typed error envelope schema** — `ErrorEnvelopeSchema` (structured error responses)
- **Version file** — `contracts.version.json` (schema inventory and drift detection)

### How to run contracts check + doctor

```bash
# Validate all schemas, SDK exports, and CLI entrypoints
pnpm run contracts:check

# Verify environment, build prerequisites, and security invariants
pnpm run doctor
```

`contracts:check` validates:
1. All Zod schemas parse with representative data
2. SDK public API surface matches `contracts.version.json`
3. CLI binary exists and every subcommand responds to `--help`
4. `contracts.version.json` is well-formed and all listed schemas exist in source

`doctor` checks:
1. Node.js >= 20 and pnpm >= 9
2. Workspace packages installed
3. TypeScript compiler available
4. Build output present
5. No secret leakage patterns in source
6. Required config files present

Both commands are enforced in CI on every pull request and push to main.

## Testing

```bash
pnpm run test              # Run all tests
pnpm run test:coverage     # Run with coverage
pnpm run test:watch        # Watch mode
pnpm run verify:fast       # Lint + typecheck + build
pnpm run verify:full       # verify:fast + test
pnpm run contracts:check   # Validate schemas + exports + CLI
pnpm run doctor            # Environment + security checks
pnpm run cost-risk:audit   # CI cost risk guardrails
pnpm run docs:verify       # CLI + docs verification
```

## Examples

See `examples/` directory for sample data and usage patterns:
- `examples/sample-data/billing-events.json` - Sample billing export
- `examples/sample-data/churn-inputs.json` - Churn assessment inputs
- `examples/sample-data/job-requests.json` - JobForge job request examples
- `examples/jobforge/input.json` - JobForge analyze inputs
- `examples/output/jobforge/` - JobForge analyze outputs (stable mode)

## CI/CD

GitHub Actions workflow included:
- `verify:fast`, `contracts:check`, `contracts:compat`, `doctor` on pull requests
- `verify:full`, `contracts:check`, `contracts:compat`, `doctor`, `docs:verify` on main

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

Apache-2.0 © AnomalyCo
