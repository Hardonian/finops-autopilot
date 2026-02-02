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
pnpm run check

# CLI usage
finops ingest --events ./billing-events.json --tenant my-tenant --project my-project
finops reconcile --normalized ./normalized.json --tenant my-tenant --project my-project
finops anomalies --ledger ./ledger.json --tenant my-tenant --project my-project
finops churn --inputs ./churn-inputs.json --tenant my-tenant --project my-project
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

## Testing

```bash
pnpm run test              # Run all tests
pnpm run test:coverage     # Run with coverage
pnpm run test:watch        # Watch mode
```

## Examples

See `examples/` directory for sample data and usage patterns:
- `examples/sample-data/billing-events.json` - Sample billing export
- `examples/sample-data/churn-inputs.json` - Churn assessment inputs
- `examples/sample-data/job-requests.json` - JobForge job request examples

## CI/CD

GitHub Actions workflow included:
- Lint with ESLint
- Type checking with TypeScript
- Unit tests with Vitest
- Build verification

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT © AnomalyCo
