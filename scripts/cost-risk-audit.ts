import { getCapabilityMetadata } from '../src/health/index.js';

const MAX_TIMEOUT_SECONDS = 3600;
const MAX_RETRIES = 5;

function runAudit(): void {
  const metadata = getCapabilityMetadata();
  const violations: string[] = [];

  for (const job of metadata.job_types) {
    if (!Number.isFinite(job.max_retries) || job.max_retries < 0) {
      violations.push(`${job.job_type}: max_retries must be set and non-negative`);
    }

    if (job.max_retries > MAX_RETRIES) {
      violations.push(`${job.job_type}: max_retries ${job.max_retries} exceeds ${MAX_RETRIES}`);
    }

    if (!Number.isFinite(job.timeout_seconds) || job.timeout_seconds <= 0) {
      violations.push(`${job.job_type}: timeout_seconds must be set and positive`);
    }

    if (job.timeout_seconds > MAX_TIMEOUT_SECONDS) {
      violations.push(`${job.job_type}: timeout_seconds ${job.timeout_seconds} exceeds ${MAX_TIMEOUT_SECONDS}`);
    }

    if (!job.idempotent) {
      violations.push(`${job.job_type}: idempotent must be true`);
    }

    if (!job.retryable) {
      violations.push(`${job.job_type}: retryable must be true`);
    }
  }

  const costSnapshot = metadata.job_types.find(
    (job) => job.job_type === 'autopilot.finops.cost_snapshot'
  );

  if (!costSnapshot?.cacheable || !costSnapshot.cache_invalidation_rule) {
    violations.push('autopilot.finops.cost_snapshot: cacheable with invalidation rule required');
  }

  if (violations.length > 0) {
    console.error('Cost risk audit failed:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Cost risk audit passed.');
  }
}

runAudit();
