---
id: monitor-dashboard-ui-ux
name: Dashboard UI and UX
paths:
- apps/dashboard/**
- tests/browser/**
---

# Product and frontend review

- Review from a router owner's perspective. Prioritize clear navigation, meaningful overview and drilldowns, consistent visual hierarchy, readable charts/tables, responsive desktop/mobile layouts and accessible keyboard/focus behavior.
- Evaluate loading, empty, error, offline, stale, partial and unsupported data states. Clearly distinguish zero from missing and stale from live. Verify labels, units, timestamps, chart gaps and informative feedback.
- Every visible control should work as advertised. Check enrollment, settings, rotation, deletion, diagnostics, confirmations, pending/failed/expired states and receipt-based completion. Avoid duplicate submissions, fake controls and misleading success messages.
- Check contrast, target sizes, long labels, small viewports, overflow, zoom, dialog focus/escape and semantic labels. Do not rely on color alone for important status. Avoid unnecessary motion or dependencies.
- Identify concrete usability issues rather than subjective aesthetic preferences. When visual behavior cannot be established from source, request targeted browser/Playwright evidence, not invented screenshots or visual results.
