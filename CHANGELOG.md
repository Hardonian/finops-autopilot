# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-03

### Added
- Initial release of finops-autopilot
- Billing event ingestion and normalization
- MRR reconciliation with discrepancy detection
- Anomaly detection (9 types: duplicate events, missing invoices, double charges, refund spikes, dispute spikes, payment failure spikes, out-of-sequence events)
- Churn risk assessment with explainable signals
- JobForge integration with request bundle generation
- CLI with 5 commands: ingest, reconcile, anomalies, churn, analyze
- 6 pre-configured profiles: base, jobforge, settler, readylayer, aias, keys
- Deterministic output with canonical SHA-256 hashing
- Security module with path validation and safe JSON parsing
- Comprehensive test suite (38 tests)
- GitHub Actions CI/CD pipeline

### Security
- Input path validation to prevent directory traversal
- Tenant context validation
- Safe JSON parsing with size limits
- Sanitized logging to prevent data leakage
- Secrets scanning via GitHub Actions

## [Unreleased]

### Planned
- Health endpoint for JobForge registry
- Capability metadata endpoint
- DLQ (Dead Letter Queue) semantics documentation
- Rate limiting controls
