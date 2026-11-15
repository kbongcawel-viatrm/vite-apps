# Development Assessment Rule
## Mandatory Security Assessment for All Python Code

**Effective Date:** November 15, 2026  
**Status:** ✅ ACTIVE  
**Applies To:** ALL Python scripts, containers, and processes in vite-apps workspace

---

## 🎯 Purpose

This document establishes a **mandatory assessment rule** to ensure that all Python scripts, containers, and processes deployed in the vite-apps workspace meet security and quality standards before being merged to any branch.

**Goal:** Reduce technical debt and prevent security vulnerabilities from entering the codebase.

---

## 📜 Rule Statement

> **NO Python script, container definition, or process may be merged to any branch (including main/master) without completing a security assessment and receiving approval.**

This rule applies to:
- New Python scripts
- Modified Python scripts (if changes affect security)
- New container definitions (Dockerfiles)
- Modified container definitions
- New compose configurations
- Modified compose configurations
- New processes (cron jobs, systemd services, etc.)
- Modified processes

---

## 📋 Assessment Checklist Summary

### For ALL Python Scripts:
- ✅ All user inputs validated
- ✅ All subprocess calls use shell=False
- ✅ No hardcoded secrets
- ✅ Atomic file operations
- ✅ Proper error handling
- ✅ Authentication/authorization implemented
- ✅ Rate limiting on public endpoints
- ✅ Code linted (pylint/flake8)
- ✅ Tests written and passing
- ✅ Documentation updated

### For ALL Container Definitions:
- ✅ Runs as non-root user
- ✅ All capabilities dropped
- ✅ No new privileges
- ✅ Read-only filesystem where possible
- ✅ Resource limits configured
- ✅ Healthcheck configured
- ✅ No unnecessary host mounts
- ✅ SELinux labels on volumes
- ✅ Minimal base image
- ✅ No secrets in image

### For ALL Processes:
- ✅ Runs as non-root user
- ✅ Has resource limits
- ✅ Has proper logging
- ✅ Has error handling
- ✅ No hardcoded secrets

---

## 📊 Severity Levels

| Level | Description | Action | Can Merge? |
|-------|-------------|--------|------------|
| 🔴 CRITICAL | Severe vulnerability, immediate risk | MUST FIX BEFORE MERGE | ❌ NO |
| 🟡 HIGH | Significant vulnerability, high risk | MUST FIX BEFORE MERGE | ❌ NO |
| 🟡 MEDIUM | Moderate vulnerability | SHOULD FIX BEFORE MERGE | ⚠️ With waiver |
| 🟢 LOW | Minor issue | FIX IN FOLLOW-UP | ✅ YES |

---

## 🎯 Workflow

1. **Development:** Write code following best practices
2. **Self-Assessment:** Developer completes checklist, fixes CRITICAL/HIGH issues
3. **Peer Review:** Peer verifies checklist and approves
4. **Automated Scanning:** CI/CD runs scans, blocks on CRITICAL/HIGH
5. **Final Approval:** Maintainer reviews and approves merge
6. **Post-Merge:** Monitor, track remaining issues

---

## 🔧 Tools

```bash
# Python security
bandit -r path/to/code
safety check
pip-audit
pylint path/to/code
pytest --cov=path/to/code

# Container security
trivy image image-name:tag
hadolint Dockerfile
podman scan container-name
```

---

## 📝 Documentation Requirements

Each PR must include:
- Assessment summary
- Checklist completion status
- Scan results
- Approval sign-offs

---

## ✅ Approval

**This rule is effective immediately.**

**Approved by:** [Your Name]  
**Date:** November 15, 2026  
**Status:** ✅ ACTIVE

---

**Document Status:** ✅ ACTIVE