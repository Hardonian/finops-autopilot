import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const cliPath = resolve(root, 'dist', 'cli.js');

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

const helpArgs = [
  ['--help'],
  ['ingest', '--help'],
  ['reconcile', '--help'],
  ['anomalies', '--help'],
  ['churn', '--help'],
  ['analyze', '--help'],
];

for (const args of helpArgs) {
  run('node', [cliPath, ...args]);
}

const inputPath = resolve(root, 'examples', 'jobforge', 'input.json');
const outputDir = resolve(root, 'examples', 'output', 'jobforge-generated');
const expectedDir = resolve(root, 'examples', 'output', 'jobforge');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

run('node', [
  cliPath,
  'analyze',
  '--inputs',
  inputPath,
  '--tenant',
  'demo-tenant',
  '--project',
  'demo-project',
  '--trace',
  'trace-demo',
  '--out',
  outputDir,
  '--stable-output',
]);

const expectedFiles = ['request-bundle.json', 'report.json', 'report.md'];

for (const file of expectedFiles) {
  const actual = readFileSync(resolve(outputDir, file), 'utf-8');
  const expected = readFileSync(resolve(expectedDir, file), 'utf-8');
  if (actual !== expected) {
    throw new Error(`Docs verify mismatch for ${file}`);
  }
}
