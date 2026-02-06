/**
 * pnpm doctor — verifies environment, build prerequisites, and security invariants.
 *
 * Checks:
 *  1. Node.js version >= 20
 *  2. pnpm available and correct version
 *  3. Required workspace packages installed
 *  4. TypeScript compiler available
 *  5. Build output exists (dist/)
 *  6. No secret leakage patterns in source or logs
 *  7. Required config files present
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  remediation?: string;
}

const results: CheckResult[] = [];

function addResult(result: CheckResult): void {
  results.push(result);
}

function getCommandOutput(cmd: string, args: string[]): string | null {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 10_000 });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

// ---- 1. Node.js version ----

const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);

if (nodeMajor >= 20) {
  addResult({ name: 'Node.js version', status: 'pass', message: `${nodeVersion} (>= 20 required)` });
} else {
  addResult({
    name: 'Node.js version',
    status: 'fail',
    message: `${nodeVersion} — minimum is v20.0.0`,
    remediation: 'Install Node.js >= 20: https://nodejs.org/ or use nvm install 20',
  });
}

// ---- 2. pnpm ----

const pnpmVersion = getCommandOutput('pnpm', ['--version']);
if (pnpmVersion) {
  const pnpmMajor = parseInt(pnpmVersion.split('.')[0], 10);
  if (pnpmMajor >= 9) {
    addResult({ name: 'pnpm version', status: 'pass', message: `${pnpmVersion} (>= 9 required)` });
  } else {
    addResult({
      name: 'pnpm version',
      status: 'fail',
      message: `${pnpmVersion} — minimum is 9.0.0`,
      remediation: 'Run: corepack enable && corepack prepare pnpm@9 --activate',
    });
  }
} else {
  addResult({
    name: 'pnpm version',
    status: 'fail',
    message: 'pnpm not found',
    remediation: 'Install pnpm: npm install -g pnpm@9 or corepack enable',
  });
}

// ---- 3. Workspace packages ----

const workspacePackages = ['contracts', 'profiles', 'jobforge-client'];
for (const pkg of workspacePackages) {
  const pkgPath = resolve(root, 'packages', pkg, 'package.json');
  if (existsSync(pkgPath)) {
    addResult({ name: `workspace:${pkg}`, status: 'pass', message: `packages/${pkg} present` });
  } else {
    addResult({
      name: `workspace:${pkg}`,
      status: 'fail',
      message: `packages/${pkg}/package.json missing`,
      remediation: `Ensure packages/${pkg}/ exists and run pnpm install`,
    });
  }
}

// ---- 4. TypeScript compiler ----

const tscVersion = getCommandOutput('npx', ['tsc', '--version']);
if (tscVersion) {
  addResult({ name: 'TypeScript', status: 'pass', message: tscVersion });
} else {
  addResult({
    name: 'TypeScript',
    status: 'fail',
    message: 'tsc not found',
    remediation: 'Run: pnpm install (TypeScript is a devDependency)',
  });
}

// ---- 5. Build output ----

const distIndex = resolve(root, 'dist', 'index.js');
const distCli = resolve(root, 'dist', 'cli.js');

if (existsSync(distIndex) && existsSync(distCli)) {
  addResult({ name: 'Build output', status: 'pass', message: 'dist/index.js and dist/cli.js present' });
} else {
  addResult({
    name: 'Build output',
    status: 'warn',
    message: 'dist/ is missing or incomplete',
    remediation: 'Run: pnpm run build',
  });
}

// ---- 6. Secret leakage scan ----

const SECRET_PATTERNS = [
  { label: 'AWS key', pattern: /AKIA[0-9A-Z]{16}/g },
  { label: 'private key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { label: 'Stripe secret key', pattern: /sk_live_[0-9a-zA-Z]{24,}/g },
  { label: 'GitHub token', pattern: /ghp_[0-9a-zA-Z]{36}/g },
  { label: 'generic secret assignment', pattern: /(?:secret|password|token|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/gi },
];

function scanDir(dir: string, extensions: string[]): string[] {
  const hits: string[] = [];
  if (!existsSync(dir)) return hits;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
      hits.push(...scanDir(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      const stat = statSync(fullPath);
      if (stat.size > 1_000_000) continue; // skip files > 1MB
      const content = readFileSync(fullPath, 'utf-8');
      for (const { label, pattern } of SECRET_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          hits.push(`${label} found in ${fullPath.replace(root + '/', '')}`);
        }
      }
    }
  }
  return hits;
}

const secretHits = scanDir(resolve(root, 'src'), ['.ts', '.js', '.json']);
secretHits.push(...scanDir(resolve(root, 'scripts'), ['.ts', '.js']));
secretHits.push(...scanDir(resolve(root, 'examples'), ['.json', '.ts', '.js']));

if (secretHits.length === 0) {
  addResult({ name: 'Secret leakage scan', status: 'pass', message: 'No secret patterns detected in source' });
} else {
  addResult({
    name: 'Secret leakage scan',
    status: 'fail',
    message: `${secretHits.length} potential secret(s) found`,
    remediation: secretHits.join('\n    '),
  });
}

// ---- 7. Required config files ----

const requiredFiles = [
  'package.json',
  'tsconfig.json',
  'eslint.config.js',
  'vitest.config.ts',
  'pnpm-workspace.yaml',
  'contracts.version.json',
  '.github/workflows/ci.yml',
];

for (const file of requiredFiles) {
  const filePath = resolve(root, file);
  if (existsSync(filePath)) {
    addResult({ name: `config:${file}`, status: 'pass', message: 'present' });
  } else {
    addResult({
      name: `config:${file}`,
      status: 'fail',
      message: `${file} missing`,
      remediation: `Create or restore ${file}`,
    });
  }
}

// ---- 8. node_modules installed ----

const nodeModulesPath = resolve(root, 'node_modules');
if (existsSync(nodeModulesPath)) {
  addResult({ name: 'node_modules', status: 'pass', message: 'installed' });
} else {
  addResult({
    name: 'node_modules',
    status: 'fail',
    message: 'node_modules missing',
    remediation: 'Run: pnpm install',
  });
}

// ---- Report ----

console.log('\n  finops-autopilot doctor\n');

let hasFailures = false;
let hasWarnings = false;

for (const r of results) {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
  const prefix = r.status === 'pass' ? '  ' : r.status === 'warn' ? '  ' : '  ';
  console.log(`${prefix}${icon} ${r.name}: ${r.message}`);
  if (r.remediation && r.status !== 'pass') {
    console.log(`    → ${r.remediation}`);
  }
  if (r.status === 'fail') hasFailures = true;
  if (r.status === 'warn') hasWarnings = true;
}

const passCount = results.filter((r) => r.status === 'pass').length;
const failCount = results.filter((r) => r.status === 'fail').length;
const warnCount = results.filter((r) => r.status === 'warn').length;

console.log(`\n  ${passCount} passed, ${warnCount} warning(s), ${failCount} failure(s)\n`);

if (hasFailures) {
  process.exitCode = 1;
} else if (hasWarnings) {
  console.log('  All checks passed (with warnings).\n');
} else {
  console.log('  All checks passed.\n');
}
