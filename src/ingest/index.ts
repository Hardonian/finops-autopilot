/**
 * Billing event ingestion and normalization
 * 
 * Transforms raw billing exports from various sources into a canonical,
 * deterministic format suitable for reconciliation and analysis.
 */

import { createHash } from 'crypto';
import type {
  BillingEvent,
  NormalizedEvent,
  TenantId,
  ProjectId,
} from '../contracts/index.js';
import {
  BillingEventSchema,
  NormalizedEventSchema,
} from '../contracts/index.js';

export interface IngestOptions {
  tenantId: TenantId;
  projectId: ProjectId;
  skipValidation?: boolean;
}

export interface IngestResult {
  events: NormalizedEvent[];
  errors: IngestError[];
  stats: IngestStats;
}

export interface IngestError {
  index: number;
  rawEvent: unknown;
  error: string;
}

export interface IngestStats {
  total: number;
  valid: number;
  invalid: number;
  byType: Record<string, number>;
}

/**
 * Compute a stable hash for a billing event
 * Used for deduplication and deterministic ordering
 */
function computeEventHash(event: Omit<NormalizedEvent, 'source_hash'>): string {
  const canonical = {
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    event_id: event.event_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    customer_id: event.customer_id,
    subscription_id: event.subscription_id,
    invoice_id: event.invoice_id,
    amount_cents: event.amount_cents,
    currency: event.currency,
    plan_id: event.plan_id,
  };
  
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

/**
 * Ingest and normalize raw billing events
 * 
 * @param rawEvents - Array of raw billing event objects
 * @param options - Ingestion options including tenant and project IDs
 * @returns Normalized events with validation results
 */
export function ingestEvents(
  rawEvents: unknown[],
  options: IngestOptions
): IngestResult {
  const events: NormalizedEvent[] = [];
  const errors: IngestError[] = [];
  const byType: Record<string, number> = {};

  for (const [index, raw] of rawEvents.entries()) {
    try {
      // Ensure raw is an object
      if (typeof raw !== 'object' || raw === null) {
        errors.push({
          index,
          rawEvent: raw,
          error: 'Event must be an object',
        });
        continue;
      }

      // Merge with required tenant/project
      const withContext = {
        ...raw,
        tenant_id: options.tenantId,
        project_id: options.projectId,
        metadata: (raw as Record<string, unknown>).metadata || {},
        raw_payload: raw as Record<string, unknown>,
      };

      // Validate against schema
      const parseResult = BillingEventSchema.safeParse(withContext);
      
      if (!parseResult.success) {
        const validationErrors = parseResult.error.errors.map(
          (e) => `${e.path.join('.')}: ${e.message}`
        );
        
        errors.push({
          index,
          rawEvent: raw,
          error: validationErrors.join(', '),
        });
        
        // Optionally include invalid events with validation errors
        if (!options.skipValidation) {
          continue;
        }
      }

      const baseEvent = parseResult.success 
        ? parseResult.data 
        : (withContext as BillingEvent);

      // Compute hash and create normalized event
      const normalized: NormalizedEvent = {
        ...baseEvent,
        normalized_at: new Date().toISOString(),
        source_hash: computeEventHash({
          ...baseEvent,
          normalized_at: '',
          source_hash: '',
          validation_errors: [],
        }),
        validation_errors: parseResult.success 
          ? [] 
          : parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
      };

      // Validate normalized event
      const normalizedResult = NormalizedEventSchema.safeParse(normalized);
      if (!normalizedResult.success) {
        errors.push({
          index,
          rawEvent: raw,
          error: `Normalized event validation failed: ${normalizedResult.error.errors.map(e => e.message).join(', ')}`,
        });
        continue;
      }

      events.push(normalizedResult.data);
      
      // Update stats
      byType[normalizedResult.data.event_type] = (byType[normalizedResult.data.event_type] || 0) + 1;
    } catch (err) {
      errors.push({
        index,
        rawEvent: raw,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Sort by timestamp, then event_id for deterministic ordering
  events.sort((a, b) => {
    const timeCompare = a.timestamp.localeCompare(b.timestamp);
    return timeCompare !== 0 ? timeCompare : a.event_id.localeCompare(b.event_id);
  });

  return {
    events,
    errors,
    stats: {
      total: rawEvents.length,
      valid: events.length,
      invalid: errors.length,
      byType,
    },
  };
}

/**
 * Load events from a JSON file path or array
 */
export async function loadEvents(source: string | unknown[]): Promise<unknown[]> {
  if (Array.isArray(source)) {
    return source;
  }

  // In Node environment, we'd read from filesystem
  // For now, assume the caller handles file loading
  throw new Error('File loading not implemented in browser environment. Pass array directly.');
}

/**
 * Serialize normalized events to JSON with deterministic ordering
 */
export function serializeEvents(events: NormalizedEvent[]): string {
  return JSON.stringify(events, null, 2);
}
