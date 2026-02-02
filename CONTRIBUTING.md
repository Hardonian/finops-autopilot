# Contributing to FinOps Autopilot

Thank you for your interest in contributing!

## Development Setup

```bash
# Install dependencies
pnpm install

# Run all checks
pnpm run check

# Or run individually
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

## Project Structure

```
src/
├── contracts/     # Zod schemas for all data types
├── ingest/        # Billing event normalization
├── reconcile/     # MRR computation and reconciliation
├── anomalies/     # Anomaly detection algorithms
├── churn/         # Churn risk assessment
├── jobforge/      # JobForge job request generation
├── profiles/      # Base + per-app profiles
├── cli.ts         # Command-line interface
└── index.ts       # Public API exports
```

## Non-Negotiables

1. **No secrets storage** - Only file-based inputs
2. **Multi-tenant safety** - All data requires tenant_id + project_id
3. **Deterministic outputs** - Same input must produce same output
4. **No financial advice** - Operational insights only
5. **Runnerless** - No workers, schedulers, or long-running processes

## Testing

All tests must pass before merging:

```bash
# Unit tests
pnpm run test

# Coverage
pnpm run test:coverage

# Determinism tests
pnpm run test -- --reporter=verbose
```

## Code Style

- TypeScript with strict mode enabled
- ESLint with strict rules
- Explicit return types on all functions
- No `any` types without justification

## Pull Request Process

1. Ensure all tests pass
2. Update examples if needed
3. Update README if adding features
4. Follow conventional commit format

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
