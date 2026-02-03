# JobForge Integration

This module is runnerless: it never executes jobs. It emits JobForge-compatible request bundles and reports for downstream execution.

## CLI command JobForge should run

```bash
finops analyze \
  --inputs ./fixtures/jobforge/input.json \
  --tenant tenant-demo \
  --project project-demo \
  --trace trace-demo \
  --out ./out/jobforge \
  --stable-output
```

## Output artifacts

The command writes the following files:

- `out/jobforge/request-bundle.json` — JobRequestBundle (dry-run only)
- `out/jobforge/report.json` — ReportEnvelope compatible with JobForge contracts
- `out/jobforge/report.md` — Optional Markdown rendering (omit with `--no-markdown`)

Each output includes:

- `schema_version` (`1.0.0`)
- `module_id` (`finops`)
- `tenant_id` and `project_id`
- `trace_id`
- per-request `idempotency_key`
- canonicalization metadata with a stable SHA-256 hash

Stable fixtures can be exported with:

```bash
pnpm run fixtures:export
```

This writes deterministic artifacts to:

- `fixtures/jobforge/request-bundle.json`
- `fixtures/jobforge/report.json`
- `fixtures/jobforge/report.md`

## How JobForge should ingest and validate

1. Read `request-bundle.json` and validate against `JobRequestBundleSchema` from `@autopilot/contracts` (or the local compat schema in `src/contracts/compat.ts`).
2. Run the preflight checks:
   - tenant/project match across all requests
   - `idempotency_key` present for every request
   - action-like requests include `requires_policy_token: true` in metadata
3. Read `report.json` and validate against `ReportEnvelope` (compat schema included in `src/contracts/compat.ts`).
4. Use the canonicalization hash for deterministic storage and dedupe.

## Contract alignment

`src/contracts/compat.ts` mirrors the canonical `@autopilot/contracts` JobForge schemas and pins to `schema_version` `1.0.0`. Alignment is verified by `pnpm run contracts:compat`, which regenerates stable outputs from fixtures and asserts the canonical hashes and snapshot fixtures remain byte-for-byte consistent.

## Safety boundaries

- The module never executes jobs; it only emits request payloads.
- No secrets or PII are logged in CLI outputs or docs.
- Multi-tenant scoping is enforced via `tenant_id` and `project_id` in all artifacts.
