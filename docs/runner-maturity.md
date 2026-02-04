# Runner Maturity (All)

This module is runnerless, but it emits JobForge-compatible job requests. Each runner below documents execution guarantees, metrics, cost awareness hooks, and failure modes for downstream execution.

## Standard Metrics Export

Metrics are exported as a `RunnerMetricsReport` JSON payload (see `RunnerMetricsReportSchema`). Each record is scoped to a time window and includes success/failure counts, retries, latency percentiles, and cost risk flags. Consumers should export one metric record per runner per reporting window.

Required fields per metric:
- `runner_id` (string)
- `job_type` (string)
- `window_start` / `window_end` (ISO timestamps)
- `captured_at` (ISO timestamp)
- `success_count` / `failure_count`
- `retry_count` / `idempotent_replay_count`
- `input_records` / `output_records`
- `latency_ms_p50` / `latency_ms_p95`
- `cost_risk_flags` (array of strings)

## FinOps Hooks (Mandatory)

Every job request emitted by this module includes `finops_hooks` in the payload or metadata with:
- `module_id`
- `capability`
- `tenant_id`
- `project_id`
- `cost_context` (`cost_center` and tag list)

Downstream runners must preserve these hooks in telemetry to enable cost attribution and chargeback.

---

## Runner: `autopilot.finops.reconcile`

**Purpose**
- Normalize billing events, build ledger state, and reconcile expected vs observed MRR.

**Inputs**
- Billing events export (`events_path` file input)
- Required context: `tenant_id`, `project_id`, `period_start`, `period_end`

**Outputs**
- `ReconReport` JSON
- `LedgerState` JSON

**Execution Guarantees**
- Idempotent: deterministic inputs produce deterministic outputs.
- Retry semantics: retryable with exponential backoff, max 3 attempts.

**Metrics**
- `success_count`: reconciliations completed without validation errors.
- `failure_count`: reconciliation failures (validation/schema/tenant mismatch).
- `retry_count`: retries executed due to transient failures.
- `output_records`: number of discrepancies detected.
- `cost_risk_flags`: `unbounded_input` if event count exceeds configured limits.

**Failure Modes**
- Validation failures (schema mismatch, missing required fields).
- Tenant mismatch or unauthorized tenant context.
- Time window invalid or missing data.

---

## Runner: `autopilot.finops.anomaly_scan`

**Purpose**
- Detect anomalies from ledger state (refund spikes, disputes, duplicates, usage drops).

**Inputs**
- Ledger state (`ledger_path` file input)
- Required context: `tenant_id`, `project_id`, `reference_date`

**Outputs**
- `Anomaly[]` JSON array

**Execution Guarantees**
- Idempotent: same ledger input yields identical anomalies.
- Retry semantics: retryable with exponential backoff, max 3 attempts.

**Metrics**
- `success_count`: anomaly scans completed.
- `failure_count`: invalid ledger schema or tenant mismatch.
- `output_records`: anomaly count.
- `cost_risk_flags`: `high_anomaly_volume` if anomaly count exceeds thresholds.

**Failure Modes**
- Ledger schema validation failure.
- Missing reference date or invalid timestamp.

---

## Runner: `autopilot.finops.churn_risk_report`

**Purpose**
- Assess churn risk and generate explainable risk signals.

**Inputs**
- Ledger state (`ledger_path` file input)
- Optional usage metrics / support tickets
- Required context: `tenant_id`, `project_id`, `reference_date`

**Outputs**
- `ChurnRisk[]` JSON array

**Execution Guarantees**
- Idempotent: stable inputs and profile thresholds yield stable results.
- Retry semantics: retryable with exponential backoff, max 3 attempts.

**Metrics**
- `success_count`: churn risk assessments completed.
- `failure_count`: missing or invalid inputs.
- `output_records`: number of customer risk entries.
- `cost_risk_flags`: `excessive_retry` if retries exceed expected baseline.

**Failure Modes**
- Missing ledger or invalid schema.
- Invalid support/usage metrics payloads.

---

## Runner: `autopilot.finops.cost_snapshot`

**Purpose**
- Generate deterministic cost snapshots for a period with optional forecasts.

**Inputs**
- Cost snapshot input (`CostSnapshotInput`)
- Required context: `tenant_id`, `project_id`, `period_start`, `period_end`

**Outputs**
- `CostSnapshotReport` JSON

**Execution Guarantees**
- Idempotent and deterministic.
- Cacheable with explicit invalidation (`period_end < now() - 24h` or explicit invalidation).
- Retry semantics: retryable with exponential backoff, max 3 attempts.

**Metrics**
- `success_count`: snapshots generated.
- `failure_count`: invalid period, currency mismatch, insufficient data.
- `output_records`: line item count.
- `cost_risk_flags`: `unbounded_line_items` if line item count exceeds thresholds.

**Failure Modes**
- Invalid period window.
- Mixed currencies.
- Insufficient data / refusal due to weak evidence.
