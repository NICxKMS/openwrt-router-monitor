---
id: monitor-security
name: Monitoring security and privacy
paths:
- apps/worker/**
- apps/dashboard/**
- packages/shared/**
- openwrt/**
- supabase/**
- '**/.env.example'
- scripts/**
- docs/security.md
---

# Security boundaries

- Separate Supabase owner sessions, random device credentials and backend secrets. Hash high-entropy device/enrollment tokens, consume enrollment atomically with expiry, support revocation/rotation, and verify ownership at each privileged operation.
- No backend secrets in VITE_ variables, browser bundles, firmware, UCI, logs or public output. Check private token-file permissions, curl credential handling, redaction, error sanitization and least-privilege access.
- Enforce HTTPS verification, strict input validation, origin restrictions, CSP and safe redirects. Never introduce remote shell, arbitrary diagnostic commands or disabled verification.
- Minimize telemetry: no browsing/DNS history, full configs, arbitrary process command lines or private keys. Use local anonymized client identifiers where safe, omit when unavailable, and preserve local opt-in for addresses. Redaction is not a guarantee of anonymity.
- Check private diagnostic/archive access, deletion lifecycle, abuse protection and safe limits; distinguish application protection from a guaranteed provider SLA.
