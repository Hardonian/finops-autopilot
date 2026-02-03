# CLI Reference

All commands are runnerless and operate on local files. Every command requires `tenant_id` and `project_id` for multi-tenant safety.

## Commands

| Command | Description | Example |
| --- | --- | --- |
| `finops ingest` | Normalize billing events | `finops ingest --events ./billing-events.json --tenant t1 --project p1` |
| `finops reconcile` | Build ledger + reconcile MRR | `finops reconcile --normalized ./normalized.json --tenant t1 --project p1` |
| `finops anomalies` | Detect anomalies | `finops anomalies --ledger ./ledger.json --tenant t1 --project p1` |
| `finops churn` | Assess churn risk | `finops churn --inputs ./churn-inputs.json --tenant t1 --project p1` |
| `finops analyze` | Emit JobForge bundle + report | `finops analyze --inputs ./fixtures/jobforge/input.json --tenant t1 --project p1 --trace trace-1 --out ./out/jobforge` |

## `finops analyze`

The `analyze` command produces JobForge-compatible artifacts:

- `request-bundle.json`
- `report.json`
- `report.md` (optional)

### Example

```bash
finops analyze \
  --inputs ./fixtures/jobforge/input.json \
  --tenant tenant-demo \
  --project project-demo \
  --trace trace-demo \
  --out ./out/jobforge \
  --stable-output
```
