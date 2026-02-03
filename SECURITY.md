# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

**Please do NOT:**
- Open public issues for security vulnerabilities
- Disclose vulnerabilities publicly before a fix is available

**Please DO:**
- Email security concerns to: security@anomalyco.com
- Include detailed steps to reproduce the vulnerability
- Allow reasonable time for remediation before disclosure

## Security Measures

This project implements the following security measures:

1. **Input Validation**: All file paths are validated to prevent directory traversal
2. **No Secrets Storage**: The module never stores or logs secrets
3. **Tenant Isolation**: All operations are scoped to tenant_id + project_id
4. **Safe Logging**: Error messages are sanitized to prevent data leakage
5. **Dependency Scanning**: Automated security scanning via GitHub Actions

## Security Scanning

This repository uses:
- TruffleHog for secrets detection
- CodeQL for static analysis
- GitHub Dependency Review for vulnerable dependencies

See `.github/workflows/security.yml` for implementation details.
