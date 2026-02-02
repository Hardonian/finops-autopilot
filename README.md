# finops-autopilot

A runnerless FinOps autopilot that ingests billing event exports, reconciles expected vs observed revenue, detects anomalies, and outputs explainable churn risk signals.

> **Boundary Statement**: This tool does not receive webhooks, run workers, or store secrets. It processes offline billing exports and outputs JobForge job requests for batch execution.

## Quickstart

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run checks (lint + typecheck + test)
pnpm run check

# CLI usage
finops ingest --events ./billing-events.json
finops reconcile --normalized ./normalized.json
finops anomalies --ledger ./ledger.json
finops churn --inputs ./churn-inputs.json
```

## Architecture

```
src/
├── contracts/     # Zod schemas for all data types
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

## Testing

```bash
pnpm run test              # Run all tests
pnpm run test:coverage     # Run with coverage
pnpm run test:watch        # Watch mode
```

## License

MIT © AnomalyCo
