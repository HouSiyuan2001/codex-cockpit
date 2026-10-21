# Project summary

React/TypeScript UI: `src`. Tauri/Rust native layer: `src-tauri/src`. The desktop app reads locally available provider usage, estimates cost and presents historical aggregates. Provider credentials stay in the native layer and are never part of sync payloads.

`cloud/usage-sync-worker` is the optional self-hosted Workers/D1 service. No built-in sync endpoint. HTTPS endpoint/member credentials are scoped per server and device, tokens stored in the OS credential store. Shared settings use compare-and-swap revisions. A confirmed new connection defaults to automatic sync and task-detail sharing, with a visible opt-out; existing settings remain unchanged on upgrade.

Each team's administrator owns its Cloudflare account and resources; invited users only join that server. The hardened Worker requires rate-limit bindings, rejects unknown nested aggregate/feedback fields, bounds JSON streams and supports owner-confirmed device revocation. Recovery/deletion and backup retention remain operator duties. See docs/USER-GUIDE.md and skills/cloudflare-sync/references/maintenance.md.

The application identifier is `app.codexcockpit.desktop`; no automatic import of another app's private cloud configuration. Members start unconfigured. Synthetic fixtures are only for tests/browser preview.

Calendar dates/shared plans use the existing UTC+8 convention. Arbitrary timezone selection is not implemented. v0.3.2 provides Mac universal, Windows x64 and Linux x64 packages, without notarization/Authenticode (Mac ad-hoc signature only). Signed updates use this repository's stable/beta Release feeds; users confirm before installation. Linux in-app updates require AppImage; Debian packages use manual package-manager updates. This repository is public. Build/deploy automation never changes repository visibility. See AUTO-UPDATE.md.
