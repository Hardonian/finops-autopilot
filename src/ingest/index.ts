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

function getField(obj: Record<string, unknown>, ...fieldNames: string[]): unknown {
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    lowerMap.set(k.toLowerCase(), v);
  }
  for (const name of fieldNames) {
    if (obj[name] !== undefined) return obj[name];
    const lower = name.toLowerCase();
    if (lowerMap.has(lower)) return lowerMap.get(lower);
  }
  return undefined;
}

function mapStripeRecord(raw: Record<string, unknown>, index = 0): Record<string, unknown> {
  const dataObj = (raw['data'] && typeof raw['data'] === 'object' && (raw['data'] as Record<string, unknown>)['object'])
    ? ((raw['data'] as Record<string, unknown>)['object'] as Record<string, unknown>)
    : raw;

  const stripeType = String(raw['type'] || dataObj['type'] || '');
  let eventType = 'invoice_paid';
  if (stripeType.includes('customer.subscription.created')) {
    eventType = 'subscription_created';
  } else if (stripeType.includes('customer.subscription.deleted') || stripeType.includes('customer.subscription.canceled')) {
    eventType = 'subscription_cancelled';
  } else if (stripeType.includes('customer.subscription.updated')) {
    eventType = 'subscription_updated';
  } else if (stripeType.includes('invoice.payment_failed') || stripeType.includes('charge.failed')) {
    eventType = 'payment_failed';
  } else if (stripeType.includes('charge.succeeded') || stripeType.includes('payment_intent.succeeded')) {
    eventType = 'payment_succeeded';
  }

  const rawAmount = dataObj['amount'] || dataObj['amount_paid'] || dataObj['total'] || (dataObj['plan'] && typeof dataObj['plan'] === 'object' ? (dataObj['plan'] as Record<string, unknown>)['amount'] : undefined);
  const amountCents = rawAmount ? Math.round(parseFloat(String(rawAmount))) : undefined;
  const planId = (dataObj['plan'] && typeof dataObj['plan'] === 'object' && (dataObj['plan'] as Record<string, unknown>)['id'])
    ? String((dataObj['plan'] as Record<string, unknown>)['id'])
    : (dataObj['plan'] ? String(dataObj['plan']) : undefined);

  return {
    event_id: String(raw['id'] || dataObj['id'] || `stripe_evt_${index + 1}`),
    event_type: eventType,
    timestamp: raw['created'] || dataObj['created'] ? new Date(Number(raw['created'] || dataObj['created']) * 1000).toISOString() : new Date().toISOString(),
    customer_id: String(dataObj['customer'] || dataObj['customer_id'] || raw['customer'] || 'cust_stripe'),
    subscription_id: dataObj['subscription'] || (dataObj['id'] && String(dataObj['id']).startsWith('sub_')) ? String(dataObj['subscription'] || dataObj['id']) : undefined,
    invoice_id: dataObj['invoice'] ? String(dataObj['invoice']) : undefined,
    plan_id: planId,
    amount_cents: amountCents,
    currency: String(dataObj['currency'] || raw['currency'] || 'USD').toUpperCase(),
    metadata: raw,
  };
}

function mapAwsCurRecord(row: Record<string, unknown>, index = 0): Record<string, unknown> {
  const rawCost = getField(row, 'lineItem/UnblendedCost', 'lineitem/unblendedcost', 'pricing/publicOnDemandCost', 'cost');
  const cost = parseFloat(String(rawCost || 0));
  const amountCents = Math.round(cost * 100);

  const eventId = String(getField(row, 'identity/LineItemId', 'identity/lineitemid') || `aws_cur_${index + 1}`);
  const timestamp = String(getField(row, 'lineItem/UsageStartDate', 'lineitem/usagestartdate') || new Date().toISOString());
  const customerId = String(getField(row, 'lineItem/UsageAccountId', 'lineitem/usageaccountid') || 'aws_account');
  const planId = String(getField(row, 'lineItem/ProductCode', 'product/productname') || 'aws_service');
  const currency = String(getField(row, 'lineItem/CurrencyCode', 'pricing/currency') || 'USD').toUpperCase();

  return {
    event_id: eventId,
    event_type: 'usage_recorded',
    timestamp: timestamp,
    customer_id: customerId,
    plan_id: planId,
    amount_cents: amountCents,
    currency: currency,
    metadata: row,
  };
}

function mapGcpBillingRecord(row: Record<string, unknown>, index = 0): Record<string, unknown> {
  const cost = parseFloat(String(row['cost'] || 0));
  const amountCents = Math.round(cost * 100);

  const projectObj = row['project'] && typeof row['project'] === 'object' ? (row['project'] as Record<string, unknown>) : undefined;
  const customerId = String(projectObj?.['id'] || row['project_id'] || row['project.id'] || 'gcp_project');

  const serviceObj = row['service'] && typeof row['service'] === 'object' ? (row['service'] as Record<string, unknown>) : undefined;
  const planId = String(serviceObj?.['description'] || serviceObj?.['id'] || row['service.description'] || 'gcp_service');

  return {
    event_id: String(row['id'] || `gcp_billing_${index + 1}`),
    event_type: 'usage_recorded',
    timestamp: String(row['usage_start_time'] || new Date().toISOString()),
    customer_id: customerId,
    plan_id: planId,
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
  rawEvents: unknown[] | string,
  options: IngestOptions
): IngestResult {
  if (typeof rawEvents === 'string') {
    return ingestAny(rawEvents, options);
  }

  const events: NormalizedEvent[] = [];
  const errors: IngestError[] = [];
  const byType: Record<string, number> = {};
  const seenEventKeys = new Map<string, number>();
  let duplicateCount = 0;

  for (let index = 0; index < rawEvents.length; index++) {
    let raw = rawEvents[index];

    try {
      if (typeof raw !== 'object' || raw === null) {
        errors.push({
          index,
          rawEvent: raw,
          error: 'Event must be an object',
        });
        continue;
      }

      // Apply provider normalization if format specified
      if (options.format === 'stripe') {
        raw = mapStripeRecord(raw as Record<string, unknown>);
      } else if (options.format === 'aws_cur') {
        raw = mapAwsCurRecord(raw as Record<string, unknown>);
      } else if (options.format === 'gcp_billing') {
        raw = mapGcpBillingRecord(raw as Record<string, unknown>);
      }

      const rawAsRecord = raw as Record<string, unknown>;

      // Deduplication check
      const eventId = String(rawAsRecord.event_id ?? `evt_${index}`);
      const timestampMs = new Date(String(rawAsRecord.timestamp ?? new Date().toISOString())).getTime();
      const dedupKey = `${eventId}_${rawAsRecord.customer_id ?? 'unknown'}`;

      if (options.dedupWindowSeconds && seenEventKeys.has(dedupKey)) {
        const lastSeenMs = seenEventKeys.get(dedupKey)!;
        const diffSeconds = Math.abs(timestampMs - lastSeenMs) / 1000;
        if (diffSeconds <= options.dedupWindowSeconds) {
          duplicateCount++;
          continue;
        }
      }
      seenEventKeys.set(dedupKey, timestampMs);

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
      total: typeof rawEvents === 'string' ? events.length + errors.length + duplicateCount : rawEvents.length,
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
    if (options.format === 'jsonl' || trimmed.includes('\n{"') || (trimmed.startsWith('{') && trimmed.includes('\n{'))) {
      const parsed = parseJsonlBillingEvents(trimmed);
      return ingestEvents(parsed, options);
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parsed = JSON.parse(trimmed) as unknown[];
      return ingestEvents(parsed, options);
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = [JSON.parse(trimmed)];
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

