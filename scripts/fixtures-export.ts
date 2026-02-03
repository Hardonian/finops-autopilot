import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { analyze, renderReport, AnalyzeInputsSchema } from '../src/jobforge/index.js';
import { serializeCanonical } from '../src/jobforge/deterministic.js';

const root = resolve(__dirname, '..');
const fixturesRoot = resolve(root, 'fixtures', 'jobforge');
const inputPath = resolve(fixturesRoot, 'input.json');

const rawInput = JSON.parse(readFileSync(inputPath, 'utf-8'));
const inputs = AnalyzeInputsSchema.parse(rawInput);

const { jobRequestBundle, reportEnvelope } = analyze(inputs, { stableOutput: true });

mkdirSync(fixturesRoot, { recursive: true });

writeFileSync(resolve(fixturesRoot, 'request-bundle.json'), serializeCanonical(jobRequestBundle), 'utf-8');
writeFileSync(resolve(fixturesRoot, 'report.json'), serializeCanonical(reportEnvelope), 'utf-8');
writeFileSync(resolve(fixturesRoot, 'report.md'), renderReport(reportEnvelope, 'md'), 'utf-8');

console.log('Exported JobForge fixtures to fixtures/jobforge.');
