# FinOps Autopilot Examples

This directory contains example data files demonstrating the usage of finops-autopilot.

## Files

### sample-data/billing-events.json
Sample billing events export (Stripe-compatible format) containing:
- Subscription creation events
- Invoice payments
- Payment failures
- Refunds
- Duplicate charge example

### sample-data/churn-inputs.json
Complete churn risk assessment inputs including:
- Ledger state with customer subscriptions
- Usage metrics (API calls with 81% drop for one customer)
- Support tickets
- Reference date

### sample-data/job-requests.json
Example JobForge job requests for:
- MRR reconciliation
- Anomaly detection
- Churn risk reporting

## Usage

```bash
# Install dependencies
pnpm install

# Build the project
pnpm run build

# Run ingest on sample data
./dist/cli.js ingest \
  --events examples/sample-data/billing-events.json \
  --tenant demo-tenant \
  --project demo-project \
  --output examples/output/normalized.json

# Run reconcile
./dist/cli.js reconcile \
  --normalized examples/output/normalized.json \
  --tenant demo-tenant \
  --project demo-project \
  --output examples/output/ledger.json

# Run anomaly detection
./dist/cli.js anomalies \
  --ledger examples/output/ledger.json \
  --tenant demo-tenant \
  --project demo-project \
  --profile base \
  --output examples/output/anomalies.json

# Run churn risk assessment
./dist/cli.js churn \
  --inputs examples/sample-data/churn-inputs.json \
  --tenant demo-tenant \
  --project demo-project \
  --profile base \
  --output examples/output/churn.json
```

## Expected Outputs

The examples include several intentional anomalies:
1. **Duplicate charge**: Two identical invoice_paid events for inv_003 within 2 minutes
2. **Payment failures**: Customer cus_startup_xyz has 2 payment failures
3. **Full refund**: Customer cus_acme_corp had their subscription refunded
4. **Usage drop**: 81% drop in API calls for cus_startup_xyz

These should be detected as:
- High/critical anomalies (duplicate, refund spike)
- Medium/high churn risk for affected customers
