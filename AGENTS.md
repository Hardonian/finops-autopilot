# AGENTS.md — FinOps Autopilot Operating Manual

## 1) Purpose

- **What**: A runnerless FinOps autopilot for billing reconciliation, anomaly detection, and churn risk signals. Processes offline billing exports and emits JobForge job requests for batch execution.
- **Who**: FinOps engineers, platform teams, and SaaS operators managing billing reconciliation across tenants.
- **Done means**: CLI commands execute deterministically, outputs pass schema validation, tests pass, and generated JobForge bundles are auditable with stable SHA-256 hashes.

## 2) Repo Map

| Directory | Purpose |
|-----------|---------|
| `src/` | Main source code |
| `src/__tests__/` | Unit tests (12 test files) |
| `src/contracts/` | Zod schemas — source of truth for data types |
| `src/ingest/` | Normalize billing events to canonical schema |
| `src/reconcile/` | Compute MRR expectations vs observed |
| `src/anomalies/` | Detect missing events, double charges, refund spikes |
| `src/churn/` | Explainable churn risk heuristics |
| `src/jobforge/` | Generate JobForge job requests and reports |
| `src/profiles/` | Base + per-app configuration profiles |
| `src/metrics/` | Runner maturity metrics and guards |
| `src/health/` | Health checks and status reporting |
| `src/security/` | Security validation utilities |
| `packages/` | Workspace packages (contracts, jobforge-client, profiles) |
| `scripts/` | Build-time scripts (contracts-compat, cost-risk-audit, docs-verify, fixtures-export) |
| `docs/` | Markdown documentation (cli.md, jobforge-integration.md, runner-maturity.md) |
| `examples/` | Sample data and JobForge integration examples |
| `fixtures/` | Stable test fixtures for JobForge integration tests |

**Source of truth locations**:
- Data schemas: `src/contracts/index.ts`
- CLI commands: `src/cli.ts`
- Profiles: `packages/profiles/index.js`
- Test patterns: `src/__tests__/*.test.ts`

## 3) Golden Rules (Invariants)

1. **No secrets storage** — Only processes offline billing exports; no env vars for credentials
2. **No fake data in outputs** — All claims must be backed by input data or explicit "unknown"
3. **No hard errors without context** — All throws must include actionable context
4. **Minimal diffs** — Prefer surgical changes; avoid refactors unless required
5. **Deterministic builds** — `--stable-output` mode produces identical hashes across runs
6. **Multi-tenant safe** — All data requires `tenant_id` + `project_id`
7. **Runnerless boundary** — Never implement workers, schedulers, or webhooks

## 4) Agent Workflow

```
Discover → Diagnose → Implement → Verify → Report
```

**Evidence required before changes**:
- Repro steps or test case demonstrating the issue
- File references (line numbers) for affected code
- Existing test coverage status (run `pnpm run test`)

**How to propose edits**:
1. Start with smallest safe patch (single file if possible)
2. Ensure change is reversible (no destructive migrations)
3. Add/update tests for new behavior
4. Run verification stack before claiming completion

## 5) Command Cookbook

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Dev (watch) | `pnpm run dev` |
| Build | `pnpm run build` |
| Lint | `pnpm run lint` |
| Lint fix | `pnpm run lint:fix` |
| Typecheck | `pnpm run typecheck` |
| Test | `pnpm run test` |
| Test coverage | `pnpm run test:coverage` |
| Fast verify | `pnpm run verify:fast` (lint + typecheck + build) |
| Full verify | `pnpm run verify:full` (verify:fast + test) |
| Contracts check | `pnpm run contracts:compat` |
| Cost-risk audit | `pnpm run cost-risk:audit` |
| Docs verify | `pnpm run docs:verify` |
| Fixtures export | `pnpm run fixtures:export` |
| CI | `pnpm run ci` (verify:full + cost-risk:audit) |

**CLI usage**:
```bash
finops ingest --events ./billing-events.json --tenant my-tenant --project my-project
finops reconcile --normalized ./normalized.json --tenant my-tenant --project my-project
finops analyze --inputs ./fixtures/jobforge/input.json --tenant my-tenant --project my-project --trace trace-1 --out ./out/jobforge
```

## 6) Change Safety Checklist (Required before commit)

- [ ] `pnpm run lint` passes
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run build` passes
- [ ] `pnpm run test` passes
- [ ] No dead imports (`@typescript-eslint/no-unused-vars`)
- [ ] No `any` types introduced (enforced by ESLint)
- [ ] All functions have explicit return types
- [ ] Schema changes validated with `pnpm run contracts:compat`
- [ ] New code has test coverage
- [ ] CLI help text updated if commands changed

## 7) Code Standards

**TypeScript/ESLint**:
- Strict mode enabled (`noImplicitAny`, `strictNullChecks`, etc.)
- Explicit function return types required
- No explicit `any` types allowed
- Unused vars must be prefixed with `_`
- No floating promises without handling

**Patterns**:
- ESM modules only (`"type": "module"`)
- Zod schemas for all data validation (contracts pattern)
- Pure functions preferred; side effects isolated to CLI layer
- Error handling: throw with context, never swallow

**Env vars**:
- Not detected for runtime (boundary: offline processing only)
- Build-time scripts may read from `.env` if present
- Never commit secrets (already enforced by `.gitignore`)

## 8) PR / Commit Standards

**Branch naming**: `feat/description`, `fix/description`, `chore/description`, `docs/description`

**Commit style**: Conventional commits
```
feat: add churn risk scoring for enterprise plans
fix: handle missing subscription_id in billing events
docs: update runner maturity metrics table
```

**PR description must include**:
1. Root cause (what problem this solves)
2. Files changed (bullet list with rationale)
3. Verification steps (commands run, results)
4. Breaking changes (if any)

## 9) Roadmap Hooks (Agent-Ready Backlog)

**Immediate (next 2 weeks)**:
1. **Contract drift audit** — Validate all Zod schemas match runtime usage; add missing strict validations
2. **Test coverage gaps** — `src/metrics/` and `src/health/` have minimal coverage; target 80%+
3. **Profile validation** — Add runtime profile schema validation for all 6 profiles (base, jobforge, settler, readylayer, aias, keys)
4. **Error boundary hardening** — Ensure all async CLI operations have try/catch with actionable error messages

**Short-term (30 days)**:
5. **CI enforcement** — Add cost-risk-audit to PR checks (currently only in `verify-full`)
6. **Fixture automation** — Hook fixtures:export into pre-commit for JobForge integration
7. **Documentation sync** — Ensure all CLI commands have matching examples in docs/cli.md
8. **Performance profiling** — Add timing metrics to ingest/reconcile for large billing exports (>10k events)

**Medium-term (60-90 days)**:
9. **Multi-format ingestion** — Support CSV billing exports (currently JSON only)
10. **Plugin architecture** — Extract anomaly detectors as pluggable heuristics
11. **Audit trail** — Add structured logging mode for compliance scenarios
12. **Integration tests** — Add end-to-end tests against real JobForge fixtures
