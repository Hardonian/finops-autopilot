import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  JobRequestBundleSchema,
  JobForgeReportEnvelopeSchema,
  type JobRequestBundle,
} from '../contracts/compat.js';
import { validateBundle } from '../jobforge/integration.js';
import { hashCanonical } from '../jobforge/deterministic.js';

const fixturesRoot = resolve(process.cwd(), 'fixtures', 'jobforge');

function readJson<T>(relativePath: string): T {
  const raw = readFileSync(resolve(fixturesRoot, relativePath), 'utf-8');
  return JSON.parse(raw) as T;
}

function readBundle(relativePath: string): JobRequestBundle {
  return readJson<JobRequestBundle>(relativePath);
}

describe('JobForge integration fixtures', () => {
  it('validates the request bundle fixture', () => {
    const bundle = readBundle('request-bundle.json');
    const parsed = JobRequestBundleSchema.safeParse(bundle);
    expect(parsed.success).toBe(true);
  });

  it('validates the report fixture', () => {
    const report = readJson('report.json');
    const parsed = JobForgeReportEnvelopeSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it('ensures canonical hashes match the payload content', () => {
    const bundle = readJson<{ canonicalization: { canonical_hash: string } }>('request-bundle.json');
    const report = readJson<{ canonicalization: { canonical_hash: string } }>('report.json');

    const { canonicalization: bundleCanonical, ...bundlePayload } = bundle;
    const { canonicalization: reportCanonical, ...reportPayload } = report;

    expect(bundleCanonical.canonical_hash).toBe(hashCanonical(bundlePayload));
    expect(reportCanonical.canonical_hash).toBe(hashCanonical(reportPayload));
  });

  it('passes JobForge preflight validation rules', () => {
    const bundle = readBundle('request-bundle.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(true);
  });
});

describe('JobForge negative fixtures', () => {
  it('fails when tenant_id is missing', () => {
    const bundle = readBundle('negative/bundle-missing-tenant.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails when project_id is missing', () => {
    const bundle = readBundle('negative/bundle-missing-project.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails on wrong schema_version', () => {
    const bundle = readBundle('negative/bundle-wrong-schema.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails when idempotency_key is missing', () => {
    const bundle = readBundle('negative/bundle-missing-idempotency.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
  });

  it('fails when action request lacks policy token annotation', () => {
    const bundle = readBundle('negative/bundle-action-without-policy.json');
    const result = validateBundle(bundle);
    expect(result.success).toBe(false);
    expect(result.errors.some((err) => err.includes('policy token'))).toBe(true);
  });
});
