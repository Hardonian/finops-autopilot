/**
 * FinOps Autopilot
 * 
 * A runnerless FinOps autopilot for billing reconciliation,
 * anomaly detection, and churn risk assessment.
 * 
 * Boundary Statement:
 * - No webhooks, no workers, no schedulers
 * - Processes offline billing exports only
 * - Outputs JobForge job requests for batch execution
 * - No secrets storage - all inputs via files
 * - No financial advice - operational insights only
 */

// Contracts
export {
  BillingEventSchema,
  NormalizedEventSchema,
  LedgerStateSchema,
  ReconReportSchema,
  AnomalySchema,
  AnomalyTypeSchema,
  AnomalySeveritySchema,
  ChurnRiskSchema,
  ChurnSignalSchema,
  JobRequestSchema,
  ProfileSchema,
  ChurnInputsSchema,
  CostSnapshotInputSchema,
  CostSnapshotReportSchema,
  CostLineItemSchema,
  CostBreakdownSchema,
  CostForecastSchema,
  RunnerMetricSchema,
  RunnerMetricsReportSchema,
  ModuleManifestSchema,
  EvidencePacketSchema,
  StructuredLogEventSchema,
  LogLevelSchema,
  ErrorEnvelopeSchema,
  ErrorCodeSchema,
} from './contracts/index.js';

export type {
  BillingEvent,
  BillingEventType,
  NormalizedEvent,
  LedgerState,
  CustomerLedger,
  SubscriptionState,
  ReconReport,
  MrrDiscrepancy,
  Anomaly,
  AnomalyType,
  AnomalySeverity,
  ChurnRisk,
  ChurnSignal,
  JobRequest,
  JobType,
  Profile,
  ChurnThreshold,
  AnomalyThreshold,
  ChurnInputs,
  CostSnapshotInput,
  CostSnapshotReport,
  CostLineItem,
  CostBreakdown,
  CostForecast,
  RunnerMetric,
  RunnerMetricsReport,
  ModuleManifest,
  EvidencePacket,
  StructuredLogEvent,
  LogLevel,
  ErrorEnvelope,
  ErrorCode,
} from './contracts/index.js';

// Ingest
export {
  ingestEvents,
  serializeEvents,
  loadEvents,
} from './ingest/index.js';

export type {
  IngestOptions,
  IngestResult,
  IngestError,
  IngestStats,
} from './ingest/index.js';

// Reconcile
export {
  buildLedger,
  reconcileMrr,
} from './reconcile/index.js';

export type {
  ReconcileOptions,
} from './reconcile/index.js';

// Anomalies
export {
  detectAnomalies,
} from './anomalies/index.js';

export type {
  AnomalyOptions,
  AnomalyResult,
} from './anomalies/index.js';

// Churn
export {
  assessChurnRisk,
} from './churn/index.js';

export type {
  ChurnOptions,
  ChurnResult,
} from './churn/index.js';

// JobForge
export {
  createReconcileJob,
  createAnomalyScanJob,
  createChurnRiskJob,
  createJobFromReport,
  createJobFromAnomalies,
  createJobFromChurnRisks,
  serializeJobRequest,
  serializeJobRequests,
  analyze,
  validateBundle,
  renderReport,
  AnalyzeInputsSchema,
} from './jobforge/index.js';

export type {
  JobOptions,
  AnalyzeInputs,
  AnalyzeOptions,
} from './jobforge/index.js';

// Profiles
export {
  baseProfile,
  jobforgeProfile,
  settlerProfile,
  readylayerProfile,
  aiasProfile,
  keysProfile,
  getProfile,
  listProfiles,
  mergeProfileWithOverrides,
  validateProfile,
  serializeProfile,
} from './profiles/index.js';

// Cost Snapshot (DD CAPABILITY: finops.cost_snapshot)
export {
  generateCostSnapshot,
  shouldInvalidateCache,
} from './cost-snapshot/index.js';

export type {
  CostSnapshotOptions,
} from './cost-snapshot/index.js';

// Metrics
export {
  buildRunnerMetricsReport,
  validateRunnerMetric,
  serializeRunnerMetricsReport,
} from './metrics/index.js';

export type {
  RunnerMetricsOptions,
} from './metrics/index.js';

// Health and Capabilities
export {
  getHealthStatus,
  getCapabilityMetadata,
  isSupportedJobType,
  getRetryPolicy,
  MODULE_ID,
  MODULE_VERSION,
  SCHEMA_VERSION,
} from './health/index.js';

export type {
  HealthStatus,
  CapabilityMetadata,
  JobTypeCapability,
  DLQSemantics,
} from './health/index.js';
