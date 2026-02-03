import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { JobRequestBundleSchema, JobForgeReportEnvelopeSchema } from '../contracts/compat.js';
import { validateBundle } from '../jobforge/integration.js';
import { hashCanonical } from '../jobforge/deterministic.js';

const fixturesRoot = resolve(process.cwd(), 'fixtures', 'jobforge');

function readJson<T>(relativePath: string): T {
  const raw = readFileSync(resolve(fixturesRoot, relativePath), 'utf-8');
  return JSON.parse(raw) as T;
}

describe('JobForge integration fixtures', () => {
  it('validates the request bundle fixture', () => {
    const bundle = readJson('output/request-bundle.json');
    const parsed = JobRequestBundleSchema.safeParse(bundle);
    expect(parsed.success).toBe(true);
  });

  it('validates the report fixture', () => {
    const report = readJson('output/report.json');
    const parsed = JobForgeReportEnvelopeSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it('ensures canonical hashes match the payload content', () => {
    const bundle = readJson('output/request-bundle.json') as { canonicalization: { canonical_hash: string } } & Record<string, unknown>;
    const report = readJson('output/report.json') as { canonicalization: { canonical_hash: string } } & Record<string, unknown>;

    const { canonicalization: bundleCanonical, ...bundlePayload } = bundle;
    const { canonicalization: reportCanonical, ...reportPayload } = report;

    expect(bundleCanonical.canonical_hash).toBe(hashCanonical(bundlePayload));
    expect(reportCanonical.canonical_hash).toBe(hashCanonical(reportPayload));
  });

  it('passes JobForge preflight validation rules', () => {
    const bundle = readJson('output/request-bundle.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(true);
  });
});

describe('JobForge negative fixtures', () => {
  it('fails when tenant_id is missing', () => {
    const bundle = readJson('negative/bundle-missing-tenant.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails on wrong schema_version', () => {
    const bundle = readJson('negative/bundle-wrong-schema.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails when idempotency_key is missing', () => {
    const bundle = readJson('negative/bundle-missing-idempotency.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails when action request lacks policy token annotation', () => {
    const bundle = readJson('negative/bundle-action-without-policy.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
    expect(result.errors.some((err) => err.includes('policy token'))).toBe(true);
  });
});
