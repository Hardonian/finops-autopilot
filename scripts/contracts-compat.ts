import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyze, AnalyzeInputsSchema } from '../src/jobforge/index.js';
import {
  JobForgeReportEnvelopeSchema,
  JobRequestBundleSchema,
  JOBFORGE_SCHEMA_VERSION,
} from '../src/contracts/compat.js';
import { hashCanonical, serializeCanonical } from '../src/jobforge/deterministic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const fixturesRoot = resolve(root, 'fixtures', 'jobforge');

function readJson<T>(file: string): T {
  const raw = readFileSync(resolve(fixturesRoot, file), 'utf-8');
  return JSON.parse(raw) as T;
}

function assertCanonical(payload: Record<string, unknown>, label: string): void {
  const { canonicalization, ...body } = payload as {
    canonicalization?: { canonical_hash?: string };
  };

  if (!canonicalization?.canonical_hash) {
    throw new Error(`${label} missing canonicalization hash`);
  }

  const hash = hashCanonical(body);
  if (hash !== canonicalization.canonical_hash) {
    throw new Error(`${label} canonical hash mismatch`);
  }
}

const inputs = AnalyzeInputsSchema.parse(readJson('input.json'));
const { jobRequestBundle, reportEnvelope } = analyze(inputs, { stableOutput: true });

JobRequestBundleSchema.parse(jobRequestBundle);
JobForgeReportEnvelopeSchema.parse(reportEnvelope);

if (jobRequestBundle.schema_version !== JOBFORGE_SCHEMA_VERSION) {
  throw new Error(`Unexpected schema version ${jobRequestBundle.schema_version}`);
}

assertCanonical(jobRequestBundle as Record<string, unknown>, 'jobRequestBundle');
assertCanonical(reportEnvelope as Record<string, unknown>, 'reportEnvelope');

const bundleFixture = readJson('request-bundle.json');
const reportFixture = readJson('report.json');

if (serializeCanonical(jobRequestBundle) !== serializeCanonical(bundleFixture)) {
  throw new Error('JobRequestBundle fixture mismatch');
}

if (serializeCanonical(reportEnvelope) !== serializeCanonical(reportFixture)) {
  throw new Error('Report fixture mismatch');
}

console.log('Contracts compatibility check passed.');
