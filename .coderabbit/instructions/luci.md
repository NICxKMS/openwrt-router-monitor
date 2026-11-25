---
id: monitor-luci
name: LuCI and local administration
paths:
- openwrt/luci-app-nicx-telemetry/**
- openwrt/nicx-telemetry/files/usr/libexec/rpcd/**
- openwrt/nicx-telemetry/files/etc/config/**
---

# LuCI and rpcd

- Check LuCI APIs, menu visibility, UCI options/defaults/validation, RPC method names, ACL least privilege and safe shell execution. Match configuration to the actual agent.
- Keep token files private; never return secrets in status, diagnostics or browser-readable RPC output. Check enrollment/rotation/revocation, errors and recovery.
- Review usability without SSH: clear status, pending vs applied settings, validation feedback, unavailable capabilities and safe destructive actions. Avoid unnecessary restarts or configuration conflicts.
