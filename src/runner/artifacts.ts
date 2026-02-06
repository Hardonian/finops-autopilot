/**
 * Artifact layout manager.
 *
 * Enforces the standard artifact layout:
 *   ./artifacts/<runId>/logs.jsonl
 *   ./artifacts/<runId>/evidence/*.json
 *   ./artifacts/<runId>/summary.json
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { redact } from './redact.js';
import type { LogEntry } from './logger.js';
import type { RunnerErrorEnvelope } from './errors.js';

export interface ArtifactSummary {
  run_id: string;
  command: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  idempotency_key: string;
  artifact_dir: string;
  files: string[];
  error?: RunnerErrorEnvelope;
  stats?: Record<string, unknown>;
}

export interface ArtifactWriter {
  /** Root directory for this run's artifacts. */
  readonly dir: string;
  readonly runId: string;
  readonly logsPath: string;

  /** Write a JSON evidence file into evidence/. */
  writeEvidence(name: string, data: unknown): string;

  /** Finalize: write summary.json and return it. */
  finalize(opts: {
    command: string;
    startedAt: string;
    exitCode: number;
    idempotencyKey: string;
    error?: RunnerErrorEnvelope;
    stats?: Record<string, unknown>;
    logs?: readonly LogEntry[];
  }): ArtifactSummary;
}

/**
 * Generate a deterministic run-ID from the current timestamp + randomness.
 * Format: YYYYMMDD-HHmmss-<short-uuid>
 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const short = randomUUID().slice(0, 8);
  return `${date}-${time}-${short}`;
}

/**
 * Build an idempotency key from a command name + relevant inputs.
 * The key is a SHA-256 hex digest so it can be used as a file-safe
 * dedup token.
 */
export function buildIdempotencyKey(parts: string[]): string {
  const hash = createHash('sha256');
  for (const p of parts) hash.update(p);
  return hash.digest('hex');
}

/**
 * Create an ArtifactWriter rooted at `<base>/artifacts/<runId>`.
 */
export function createArtifactWriter(base: string, runId?: string): ArtifactWriter {
  const id = runId ?? generateRunId();
  const dir = resolve(base, 'artifacts', id);
  const evidenceDir = join(dir, 'evidence');
  const logsPath = join(dir, 'logs.jsonl');

  mkdirSync(evidenceDir, { recursive: true });

  const evidenceFiles: string[] = [];

  return {
    dir,
    runId: id,
    logsPath,

    writeEvidence(name: string, data: unknown): string {
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = join(evidenceDir, `${safeName}.json`);
      const redacted = redact(data);
      writeFileSync(filePath, JSON.stringify(redacted, null, 2), 'utf-8');
      evidenceFiles.push(`evidence/${safeName}.json`);
      return filePath;
    },

    finalize(opts): ArtifactSummary {
      const summary: ArtifactSummary = {
        run_id: id,
        command: opts.command,
        started_at: opts.startedAt,
        finished_at: new Date().toISOString(),
        exit_code: opts.exitCode,
        idempotency_key: opts.idempotencyKey,
        artifact_dir: dir,
        files: ['logs.jsonl', ...evidenceFiles, 'summary.json'],
        ...(opts.error && { error: opts.error }),
        ...(opts.stats && { stats: opts.stats }),
      };

      writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
      return summary;
    },
  };
}

/**
 * Check if a previous run with the same idempotency key already produced
 * a successful summary. Used for replay / safe re-run detection.
 */
export function findPreviousRun(base: string, idempotencyKey: string): ArtifactSummary | null {
  const artifactsDir = resolve(base, 'artifacts');
  if (!existsSync(artifactsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(artifactsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const summaryPath = join(artifactsDir, entry, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      const raw = readFileSync(summaryPath, 'utf-8');
      const summary = JSON.parse(raw) as ArtifactSummary;
      if (summary.idempotency_key === idempotencyKey && summary.exit_code === 0) {
        return summary;
      }
    } catch {
      // Corrupt summary — skip
    }
  }

  return null;
}
