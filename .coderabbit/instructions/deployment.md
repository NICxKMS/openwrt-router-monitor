---
id: monitor-deployment
name: Deployment and operational safety
paths:
- scripts/**
- apps/worker/wrangler.jsonc
- docs/deployment-state.json
- docs/deployment.md
- docs/operations.md
- artifacts/**
- .github/**
- '**/package.json'
---

# Deployment, release and operations

- Review preflight, builds, package artifacts, cloud smoke scripts, environment validation, secret handling, safe retries and failure propagation. Never seed production with mock data or execute live router installation/hosted migrations without authorization.
- Validate compatibility between package version, API, shared schema, migrations and dashboard when components are rolled out separately. Verify checksums against actual bytes only when possible.
- Keep deployment-state.json accurate: source changes, local tests, hosted migrations, deployed Worker/dashboard and installed router versions are distinct. Require evidence before updating completion claims; preserve pending steps and limitations.
- GitHub only discovers repository-root .github/workflows; nested workflow files may be standalone templates, not active workflows. Review path filters, test coverage and deployment permissions accordingly.
- Review operational recovery, credential rotation, outage behavior and rollback plans. Keep privileged credentials out of examples and generated artifacts.
