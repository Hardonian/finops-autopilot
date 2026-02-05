# SKILLS.md — FinOps Autopilot Capability Map

## 1) How to Use This File

Use this document to route tasks to the right agent/model/tooling. Each section describes what exists today, what skills are required for different work types, and known risks to avoid. When starting a new task, scan this file for the relevant skill lane, then verify the "Known Risks" section before proceeding.

## 2) Current Capability Inventory

### UI/Frontend
- **Detected**: No — This is a CLI-first library with no UI layer
- **Note**: All interaction is via `src/cli.ts` or programmatic API from `src/index.ts`

### Content System
- **Detected**: Limited — Hardcoded strings in CLI commands and error messages
- **Location**: `src/cli.ts` (command descriptions, help text), `src/jobforge/report.ts` (markdown reports)
- **Pattern**: Static strings; no i18n or content management system

### Tooling
- **Detected**: Yes
- **Stack**: TypeScript 5.7+, ESLint 9.x, Vitest 2.x, pnpm 9.x, tsx
- **Commands**: lint, lint:fix, typecheck, test, test:coverage, verify:fast, verify:full
- **Quality gates**: All must pass in CI (`.github/workflows/ci.yml`)

### CI/CD
- **Detected**: Yes
- **Platform**: GitHub Actions
- **Workflows**: 
  - `ci.yml`: verify:fast + contracts:compat on PRs; verify:full + docs:verify on main
  - `security.yml`: (not analyzed — assumed security scanning)
- **Node version**: 20.x
- **Package manager**: pnpm 9.x with frozen-lockfile

### Observability
- **Detected**: Minimal
- **Coverage**: Runner maturity metrics (`src/metrics/`), health checks (`src/health/`)
- **Missing**: Structured logging, telemetry, tracing (not applicable for offline CLI tool)

### Data Validation
- **Detected**: Yes
- **Stack**: Zod 3.24+ for all schemas
- **Location**: `src/contracts/` (canonical types), `packages/contracts/` (shared workspace package)
- **Pattern**: Schema-first; runtime validation at boundaries

## 3) Skill Lanes

### Data Engineering (Primary)
**What**: Ingest, transform, reconcile billing event streams
**Examples**:
- Add new billing event types to `src/ingest/`
- Extend ledger calculations in `src/reconcile/`
- Implement new anomaly heuristics in `src/anomalies/`
**Required skills**: TypeScript strict mode, Zod validation, functional transformations

### Schema Design
**What**: Design contracts that cross module boundaries
**Examples**:
- Add fields to `BillingEvent` schema
- Create new JobForge job request types
- Profile configuration extensions
**Required skills**: Zod advanced patterns, discriminated unions, strict validation

### CLI Engineering
**What**: Build command-line interfaces with Commander.js
**Examples**:
- Add new `finops` subcommands
- Implement argument validation and help text
- Handle file I/O and error reporting
**Required skills**: Commander patterns, Node.js streams, exit codes

### Integration Engineering
**What**: Emit JobForge-compatible bundles and reports
**Examples**:
- Extend `src/jobforge/` with new job types
- Update report generators for new output formats
- Maintain fixture compatibility
**Required skills**: JSON schema compliance, deterministic hashing, stable output modes

### QA & Testing
**What**: Unit tests, integration tests, coverage enforcement
**Examples**:
- Add tests for new anomaly detectors
- Mock file system operations
- Test edge cases in reconciliation math
**Required skills**: Vitest, test doubles, coverage thresholds

### Documentation
**What**: CLI docs, integration guides, runner maturity specs
**Examples**:
- Update `docs/cli.md` with new commands
- Document JobForge integration contract
- Maintain runner maturity metrics table
**Required skills**: Technical writing, markdown, API documentation

## 4) "Which Agent for Which Task" Matrix

| Task Type | Recommended Approach | Validation |
|-----------|---------------------|------------|
| **Schema changes** | Engineer agent + Zod expert | Run `contracts:compat`, verify all usages |
| **New CLI command** | Engineer agent | Manual CLI test + unit test + docs update |
| **Anomaly heuristic** | Engineer agent + domain review | Unit test with fixtures, edge case coverage |
| **JobForge integration** | Integration specialist | Run `fixtures:export`, verify determinism |
| **Copy/documentation** | LLM pass + human skim | Link check, consistency scan |
| **Bug fix** | Engineer agent with repro test | Test fails before fix, passes after |
| **Performance optimization** | Engineer agent + profiler | Benchmark before/after, verify determinism |
| **CI/CD changes** | DevOps engineer | Test workflow in fork or feature branch |

## 5) Known Risks & Pitfalls (Observed)

### Risk: Contract Drift
- **Symptom**: Runtime objects don't match Zod schemas; validation fails in production
- **Likely cause**: Schema updated without updating all call sites
- **Diagnosis**: Run `pnpm run contracts:compat` — validates schema consistency
- **Prevention**: Always export types from `src/contracts/index.ts`; use strict mode

### Risk: Missing Test Coverage
- **Symptom**: `src/metrics/` and `src/health/` show <50% coverage
- **Likely cause**: New modules added without corresponding test files
- **Diagnosis**: Run `pnpm run test:coverage` and check uncovered lines
- **Prevention**: Require tests for new modules; add coverage gates to CI

### Risk: Non-Deterministic Output
- **Symptom**: `--stable-output` mode produces different hashes across runs
- **Likely cause**: Timestamps in output, unordered keys, or random IDs
- **Diagnosis**: Run `fixtures:export` twice; compare SHA-256 hashes
- **Prevention**: Use deterministic sorting, stable timestamps, hash-based IDs

### Risk: Profile Misconfiguration
- **Symptom**: Runtime errors when loading profiles (base, jobforge, settler, etc.)
- **Likely cause**: Profile schema mismatch or missing required fields
- **Diagnosis**: Check `packages/profiles/index.js` for runtime validation
- **Prevention**: Add Zod schema for profile validation at load time

### Risk: Floating Promises
- **Symptom**: Unhandled promise rejections in CLI operations
- **Likely cause**: Async function called without await or catch
- **Diagnosis**: ESLint `@typescript-eslint/no-floating-promises` rule
- **Prevention**: Always await promises or handle errors explicitly

### Risk: Import Path Issues
- **Symptom**: Module resolution fails in built output
- **Likely cause**: Relative imports crossing package boundaries
- **Diagnosis**: Check `dist/` output for correct `.js` extensions
- **Prevention**: Use workspace packages for cross-module imports; enforce ESM

## 6) Roadmap (Next 30/60/90 Days)

### 30 Days: Stabilize
**Goals**: Fix known issues, add missing coverage, improve DX

1. **Contract drift audit** — Run full schema validation; fix mismatches
2. **Coverage gaps** — Target 80%+ coverage in `src/metrics/` and `src/health/`
3. **Profile validation** — Add runtime Zod validation for all 6 profiles
4. **Error messages** — Audit CLI for actionable error context
5. **Docs sync** — Ensure `docs/cli.md` matches all CLI commands

### 60 Days: Enforce
**Goals**: CI hardening, drift prevention, automation

6. **CI enforcement** — Add `cost-risk:audit` to PR checks
7. **Fixture automation** — Pre-commit hook for `fixtures:export`
8. **Import boundaries** — Add ESLint rule preventing cross-package relative imports
9. **Performance gates** — Add timing thresholds for large billing exports (>10k events)
10. **Security audit** — Run `runnerless:audit` and address findings

### 90 Days: Extend
**Goals**: Feature expansion aligned to FinOps use cases

11. **Multi-format ingestion** — Support CSV billing exports (currently JSON only)
12. **Plugin architecture** — Extract anomaly detectors to pluggable heuristics
13. **Audit trail** — Structured JSON logging mode for compliance
14. **Integration tests** — End-to-end tests with real JobForge fixtures
15. **Performance profiling** — Built-in timing and memory metrics for large datasets

## 7) Definition of Done (DoD)

A change is "ship-ready" when:

- [ ] **Commands green**: `pnpm run verify:full` passes (lint, typecheck, build, test)
- [ ] **Contracts compatible**: `pnpm run contracts:compat` passes
- [ ] **No regressions**: Existing tests pass; new tests added for new behavior
- [ ] **Deterministic**: `--stable-output` produces identical results across runs
- [ ] **Documented**: CLI help text updated; `docs/` updated if applicable
- [ ] **No fake claims**: All outputs backed by input data or explicit "unknown"
- [ ] **Multi-tenant safe**: All data includes `tenant_id` + `project_id`
- [ ] **Reversible**: Change can be reverted without data loss or migration
- [ ] **Reviewed**: PR reviewed with root cause, file list, and verification steps

**Additional DoD for CLI changes**:
- Manual test of new command with sample data
- Help text reviewed for clarity
- Error cases tested with invalid inputs

**Additional DoD for schema changes**:
- All usages updated across codebase
- Backward compatibility considered (or breaking change documented)
- Fixtures regenerated with `pnpm run fixtures:export`
