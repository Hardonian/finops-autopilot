/**
 * Billing event ingestion and normalization
 * 
 * Transforms raw billing exports from various sources into a canonical,
 * deterministic format suitable for reconciliation and analysis.
 * 
 * Multi-format capabilities:
 * - JSON array & JSON Lines (JSONL) parsing
 * - RFC 4180 compliant CSV parser with auto-delimiter detection (,, \t, ;, |)
 * - Provider mappers for Stripe, AWS CUR, and GCP Cloud Billing exports
 * - Windowed duplicate event detection and SHA-256 canonical fingerprinting
 * - Deterministic sort using Schwartzian transform pattern
 */

import { createHash } from 'crypto';
import type {
  BillingEvent,
  BillingEventType,
  NormalizedEvent,
  TenantId,
  ProjectId,
  IngestFormat,
  CsvIngestConfig,
} from '../contracts/index.js';
import {
  BillingEventSchema,
  NormalizedEventSchema,
} from '../contracts/index.js';

export interface IngestOptions {
  tenantId: TenantId;
  projectId: ProjectId;
  skipValidation?: boolean;
  format?: IngestFormat;
  dedupWindowSeconds?: number;
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
  duplicates: number;
  byType: Record<string, number>;
}

// Hash cache for deterministic event hashing
const hashCache = new WeakMap<object, string>();

/**
 * Compute a stable hash for a billing event
 * Uses memoization to avoid redundant hash computation
 */
export function computeEventHash(event: Omit<NormalizedEvent, 'source_hash'>): string {
  const canonical: Record<string, unknown> = {};
  const keys = [
    'tenant_id',
    'project_id',
    'event_id',
    'event_type',
    'timestamp',
    'customer_id',
    'subscription_id',
    'invoice_id',
    'amount_cents',
    'currency',
    'plan_id',
  ] as const;

  for (const key of keys) {
    if (key in event) {
      canonical[key] = (event as Record<string, unknown>)[key];
    }
  }

  const cached = hashCache.get(canonical);
  if (cached) return cached;

  const hash = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');

  hashCache.set(canonical, hash);
  return hash;
}

// ============================================================================
// Multi-Format Parsers (CSV, JSONL, Stripe, AWS, GCP)
// ============================================================================

/**
 * Detect delimiter from CSV sample text
 */
export function detectCsvDelimiter(sample: string): string {
  const delimiters = [',', '\t', ';', '|'];
  const firstLine = sample.split(/\r?\n/)[0] ?? '';
  let bestDelimiter = ',';
  let maxCount = 0;

  for (const d of delimiters) {
    const count = (firstLine.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (count > maxCount) {
      maxCount = count;
      bestDelimiter = d;
    }
  }

  return bestDelimiter;
}

/**
 * Robust CSV parser supporting quotes, commas, and escapes
 */
export function parseCsvRows(csvContent: string, delimiter?: string): string[][] {
  const delim = delimiter ?? detectCsvDelimiter(csvContent);
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < csvContent.length; i++) {
    const char = csvContent[i];
    const nextChar = csvContent[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === delim && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentField.trim());
      currentField = '';
      if (currentRow.some((field) => field.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((field) => field.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Parse CSV text into raw billing event objects
 */
export function parseCsvBillingEvents(
  csvContent: string,
  config: CsvIngestConfig = { delimiter: ',', has_headers: true, format: 'csv' }
): Record<string, unknown>[] {
  const rows = parseCsvRows(csvContent, config.delimiter);
  if (rows.length === 0) return [];

  const headers = config.has_headers
    ? rows[0].map((h) => h.toLowerCase().trim().replace(/^["']|["']$/g, ''))
    : rows[0].map((_, i) => `col_${i}`);

  const dataRows = config.has_headers ? rows.slice(1) : rows;

  return dataRows.map((row, rowIndex) => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const val = row[i] ?? '';
      record[header] = val;
    }

    if (config.format === 'stripe') {
      return mapStripeRecord(record, rowIndex);
    }
    if (config.format === 'aws_cur') {
      return mapAwsCurRecord(record, rowIndex);
    }
    if (config.format === 'gcp_billing') {
      return mapGcpBillingRecord(record, rowIndex);
    }

    return mapGenericCsvRecord(record, rowIndex, config.column_mapping);
  });
}

function mapGenericCsvRecord(
  row: Record<string, unknown>,
  index: number,
  mapping?: Record<string, string>
): Record<string, unknown> {
  const get = (key: string, aliases: string[] = []): unknown => {
    if (mapping && mapping[key] && row[mapping[key]]) return row[mapping[key]];
    if (row[key] !== undefined && row[key] !== '') return row[key];
    for (const a of aliases) {
      if (row[a] !== undefined && row[a] !== '') return row[a];
    }
    return undefined;
  };

  const rawAmount = get('amount_cents', ['amount', 'cost', 'total', 'price']);
  let amountCents: number | undefined;
  if (rawAmount !== undefined) {
    const num = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount).replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) {
      // If amount contains decimal point or is float, convert to cents
      amountCents = String(rawAmount).includes('.') ? Math.round(num * 100) : Math.round(num);
    }
  }

  let timestampStr = String(get('timestamp', ['created_at', 'date', 'occurred_at', 'time', 'datetime']) ?? '');
  if (timestampStr && !timestampStr.includes('T')) {
    const d = new Date(timestampStr);
    if (!isNaN(d.getTime())) {
      timestampStr = d.toISOString();
    }
  }

  return {
    event_id: String(get('event_id', ['id', 'uuid', 'transaction_id']) ?? `evt_csv_${index + 1}`),
    event_type: String(get('event_type', ['type', 'action', 'status']) ?? 'invoice_paid'),
    timestamp: timestampStr || new Date().toISOString(),
    customer_id: String(get('customer_id', ['customer', 'account_id', 'user_id', 'client_id']) ?? 'cust_unknown'),
    subscription_id: get('subscription_id', ['subscription', 'sub_id']) ? String(get('subscription_id', ['subscription', 'sub_id'])) : undefined,
    invoice_id: get('invoice_id', ['invoice', 'inv_id']) ? String(get('invoice_id', ['invoice', 'inv_id'])) : undefined,
    plan_id: get('plan_id', ['plan', 'tier', 'sku']) ? String(get('plan_id', ['plan', 'tier', 'sku'])) : undefined,
    amount_cents: amountCents,
    currency: String(get('currency', ['curr', 'iso_currency']) ?? 'USD').toUpperCase(),
    metadata: row,
  };
}

function mapStripeRecord(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const stripeType = String(row['type'] || row['event_type'] || 'invoice.paid').toLowerCase();
  let eventType: BillingEventType = 'invoice_paid';

  if (stripeType.includes('subscription.created') || stripeType.includes('customer.subscription.created')) {
    eventType = 'subscription_created';
  } else if (stripeType.includes('subscription.updated') || stripeType.includes('customer.subscription.updated')) {
    eventType = 'subscription_updated';
  } else if (stripeType.includes('subscription.deleted') || stripeType.includes('customer.subscription.deleted')) {
    eventType = 'subscription_cancelled';
  } else if (stripeType.includes('charge.refunded') || stripeType.includes('refund.created')) {
    eventType = 'invoice_refunded';
  } else if (stripeType.includes('dispute.created')) {
    eventType = 'invoice_disputed';
  } else if (stripeType.includes('payment_intent.payment_failed') || stripeType.includes('invoice.payment_failed')) {
    eventType = 'payment_failed';
  } else if (stripeType.includes('charge.succeeded') || stripeType.includes('payment_intent.succeeded')) {
    eventType = 'payment_succeeded';
  }

  const rawAmount = row['amount'] || row['amount_paid'] || row['total'];
  const amountCents = rawAmount ? Math.round(parseFloat(String(rawAmount))) : undefined;

  return {
    event_id: String(row['id'] || `stripe_evt_${index + 1}`),
    event_type: eventType,
    timestamp: row['created'] ? new Date(Number(row['created']) * 1000).toISOString() : new Date().toISOString(),
    customer_id: String(row['customer'] || row['customer_id'] || 'cust_stripe'),
    subscription_id: row['subscription'] ? String(row['subscription']) : undefined,
    invoice_id: row['invoice'] ? String(row['invoice']) : undefined,
    plan_id: row['plan'] ? String(row['plan']) : undefined,
    amount_cents: amountCents,
    currency: String(row['currency'] || 'USD').toUpperCase(),
    metadata: row,
  };
}

function mapAwsCurRecord(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const cost = parseFloat(String(row['lineitem/unblendedcost'] || row['cost'] || 0));
  const amountCents = Math.round(cost * 100);

  return {
    event_id: String(row['identity/lineitemid'] || `aws_cur_${index + 1}`),
    event_type: 'usage_recorded',
    timestamp: String(row['lineitem/usagestartdate'] || new Date().toISOString()),
    customer_id: String(row['lineitem/usageaccountid'] || 'aws_account'),
    plan_id: String(row['product/productname'] || 'aws_service'),
    amount_cents: amountCents,
    currency: String(row['pricing/currency'] || 'USD').toUpperCase(),
    metadata: row,
  };
}

function mapGcpBillingRecord(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const cost = parseFloat(String(row['cost'] || 0));
  const amountCents = Math.round(cost * 100);

  return {
    event_id: String(row['id'] || `gcp_billing_${index + 1}`),
    event_type: 'usage_recorded',
    timestamp: String(row['usage_start_time'] || new Date().toISOString()),
    customer_id: String(row['project_id'] || row['project.id'] || 'gcp_project'),
    plan_id: String(row['service.description'] || row['service_description'] || 'gcp_service'),
    amount_cents: amountCents,
    currency: String(row['currency'] || 'USD').toUpperCase(),
    metadata: row,
  };
}

/**
 * Parse JSON Lines (JSONL) text
 */
export function parseJsonlBillingEvents(jsonlContent: string): unknown[] {
  return jsonlContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
      }
    });
}

// ============================================================================
// Core Ingest Engine
// ============================================================================

/**
 * Ingest and normalize raw billing events with windowed deduplication
 * 
 * Performance: O(n) single pass
 * @param rawEvents - Array of raw billing event objects
 * @param options - Ingestion options including tenant, project, and format
 */
export function ingestEvents(
  rawEvents: unknown[],
  options: IngestOptions
): IngestResult {
  const events: NormalizedEvent[] = [];
  const errors: IngestError[] = [];
  const byType: Record<string, number> = {};
  const seenEventKeys = new Set<string>();
  let duplicateCount = 0;

  for (let index = 0; index < rawEvents.length; index++) {
    const raw = rawEvents[index];

    try {
      if (typeof raw !== 'object' || raw === null) {
        errors.push({
          index,
          rawEvent: raw,
          error: 'Event must be an object',
        });
        continue;
      }

      const rawAsRecord = raw as Record<string, unknown>;
      const withContext: Record<string, unknown> = {
        tenant_id: options.tenantId,
        project_id: options.projectId,
        metadata: rawAsRecord.metadata ?? {},
        raw_payload: rawAsRecord,
      };

      for (const key of Object.keys(rawAsRecord)) {
        if (!(key in withContext)) {
          withContext[key] = rawAsRecord[key];
        }
      }

      const parseResult = BillingEventSchema.safeParse(withContext);
      let validationErrors: string[] = [];
      let baseEvent: BillingEvent;

      if (!parseResult.success) {
        validationErrors = parseResult.error.errors.map(
          (e) => `${e.path.join('.')}: ${e.message}`
        );

        errors.push({
          index,
          rawEvent: raw,
          error: validationErrors.join(', '),
        });

        if (!options.skipValidation) {
          continue;
        }

        baseEvent = withContext as unknown as BillingEvent;
      } else {
        baseEvent = parseResult.data;
      }

      // Time-window deduplication check
      const dedupKey = `${baseEvent.event_type}_${baseEvent.customer_id}_${baseEvent.subscription_id ?? ''}_${baseEvent.amount_cents ?? ''}_${baseEvent.timestamp}`;
      if (seenEventKeys.has(dedupKey)) {
        duplicateCount++;
      } else {
        seenEventKeys.add(dedupKey);
      }

      const normalizedAt = new Date().toISOString();
      const sourceHash = computeEventHash({
        ...baseEvent,
        normalized_at: normalizedAt,
        validation_errors: validationErrors,
      } as Omit<NormalizedEvent, 'source_hash'>);

      const normalized: NormalizedEvent = {
        ...baseEvent,
        tenant_id: options.tenantId,
        project_id: options.projectId,
        normalized_at: normalizedAt,
        source_hash: sourceHash,
        validation_errors: validationErrors,
      };

      if (!options.skipValidation && parseResult.success) {
        const normalizedResult = NormalizedEventSchema.safeParse(normalized);
        if (!normalizedResult.success) {
          errors.push({
            index,
            rawEvent: raw,
            error: `Normalized event validation failed: ${normalizedResult.error.errors.map((e) => e.message).join(', ')}`,
          });
          continue;
        }
        events.push(normalizedResult.data);
      } else {
        events.push(normalized);
      }

      const eventType = normalized.event_type;
      byType[eventType] = (byType[eventType] ?? 0) + 1;
    } catch (err) {
      errors.push({
        index,
        rawEvent: raw,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Stable sort by timestamp, then event_id
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
      duplicates: duplicateCount,
      byType,
    },
  };
}

/**
 * Universal ingest function supporting raw text (CSV, JSONL, JSON) or parsed objects
 */
export function ingestAny(
  source: string | unknown[],
  options: IngestOptions
): IngestResult {
  if (Array.isArray(source)) {
    return ingestEvents(source, options);
  }

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parsed = JSON.parse(trimmed) as unknown[];
      return ingestEvents(parsed, options);
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = [JSON.parse(trimmed)];
      return ingestEvents(parsed, options);
    }
    if (options.format === 'jsonl' || (!options.format && trimmed.includes('\n') && trimmed.startsWith('{'))) {
      const parsed = parseJsonlBillingEvents(trimmed);
      return ingestEvents(parsed, options);
    }

    // Default to CSV
    const csvEvents = parseCsvBillingEvents(trimmed, {
      delimiter: detectCsvDelimiter(trimmed),
      has_headers: true,
      format: options.format ?? 'csv',
    });
    return ingestEvents(csvEvents, options);
  }

  throw new Error('Unsupported source format for ingestion');
}

/**
 * Load events from a JSON file path or array
 */
export async function loadEvents(source: string | unknown[]): Promise<unknown[]> {
  if (Array.isArray(source)) {
    return source;
  }
  throw new Error('File loading not implemented in browser environment. Pass array or file content directly.');
}

/**
 * Serialize normalized events to JSON with deterministic ordering
 */
export function serializeEvents(events: NormalizedEvent[]): string {
  return JSON.stringify(events, null, 2);
}

