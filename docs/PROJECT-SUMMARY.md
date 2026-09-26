# Project summary

React/TypeScript UI: `src`. Tauri/Rust native layer: `src-tauri/src`. The desktop app reads locally available provider usage, estimates cost and presents historical aggregates. Provider credentials stay in the native layer and are never part of sync payloads.

`cloud/usage-sync-worker` is the optional self-hosted Workers/D1 service. No built-in sync endpoint. HTTPS endpoint/member credentials are scoped per server and device, tokens stored in the OS credential store. Shared settings use compare-and-swap revisions. Task/project metadata is opt-in.

The application identifier is `app.codexcockpit.desktop`; no automatic import of another app's private cloud configuration. Members start unconfigured. Synthetic fixtures are only for tests/browser preview.

Calendar dates/shared plans use the existing UTC+8 convention. Arbitrary timezone selection is not implemented. Release packages are beta, without notarization/Authenticode (Mac ad-hoc signature only). No automatic updater. Build/deploy automation never changes repository visibility.
