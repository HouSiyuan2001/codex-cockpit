# Changelog

## 0.3.3 - 2026-10-27

- Add GPT-6.1 Terra reference pricing, including its long-context tier, while preserving unknown costs.
- Use Beijing calendar days for token, cost and calendar views across host timezones; retain the separate 04:00 Beijing quota-plan boundary.
- Project task and model totals from the same details, preserve unattributed peer summaries and avoid rescanning when switching views.
- Improve incremental history scans for oversized non-usage events, recoverable cumulative-counter resets and already-covered directory aliases; continue background batches with the capsule collapsed.
- Preserve older ledgers when rebuilt details cannot yet cover their totals; keep migration pending without shrinking or double-counting history.
- Update Tokio and the Worker build toolchain for published security fixes.

## 0.3.2 - 2026-10-22

Includes the changes prepared for v0.3.1, whose two-platform workflow was cancelled before publication. The v0.3.1 tag is retained unchanged.

- Add Linux x64 AppImage/Debian packages, signed AppImage update metadata and isolated package install/startup/uninstall smoke gates. All three platforms must pass before publication.
- Initialize Xlib thread support before GTK/WebKit starts, fixing the X11 startup abort caught by packaged Linux smoke tests; repeat each package's startup check three times.
- Prevent Debian or unpackaged Linux installations from downloading an incompatible AppImage update; direct those users to manual package-manager updates.
- Update Vite and TLS/certificate dependencies for published security fixes; remove unused legacy ZIP updater support while retaining signed NSIS EXE/macOS archive updates.
- Preserve stationary capsule clicks on Linux and apply a rounded X11 window shape without animated resizing when no compositor is available. Linux end-to-end GUI/sync acceptance is still pending.
- Simplify local/cloud settings, keep update progress and retry inline, and improve update readability across themes and font sizes.
- Clarify daily budget labels and preserve expanded panels when switching control surfaces.
- Add Linux-scoped GTK input/window compatibility and Secret Service credential support; native Wayland and full Linux installation/sync acceptance remain unverified.
- Default new cloud connections to automatic sync and task-detail sharing, with an upfront notice and opt-out. Preserve existing disabled settings on upgrade.
- Keep peer task availability hints collapsed behind a compact toggle; distinguish missing details from zero usage and offer history/member filters.

## 0.3.0 - 2026-10-13

- Publish synchronized Mac universal and Windows x64 packages with signed stable-channel updates.
- Fit full task/model donut readouts at larger font sizes and keep long trend peak labels within their card.

- Integrate community PR #1 (persistent fonts), #3 (macOS Dock policy) and #4 (standalone local usage), preserving contributor commits and current native device identities.
- Fresh installations discover local Codex records, create a stable local identity and retain cached usage without requiring Tokei or cloud setup; users can confirm a manually selected directory.
- Bundle reference prices for GPT-5.6, GPT-6 and GPT-6.1 Sol. Preserve custom/shared prices and distinguish missing prices or context from zero cost.
- Add seven font choices, a readable 150% default, responsive ring labels and optional background blur. Proprietary fonts remain local-only.
- Fix Plus dual-ring alignment, missing quota-window labels, Windows expansion overhead and capsule collapse after mood/reminder interactions.
- Restore the original light icon, smooth the dark artwork, add transparent rounded corners and spacing, and switch runtime icons with the theme on Mac and Windows.
- Read scheduled reset announcements, retain known usage during incremental rescans, and keep task/model costs consistent.
- On Windows, also read still-active original Codex sessions after automatic directory migration, deduplicating copied records; manual directory selection keeps its explicit scope.
- Verify rounded icons by exact RGBA pixels across PNG encodings; retain strict Rust checks on current toolchains.
- Preserve main's nested snapshot/feedback validation, bounded streaming JSON, Cloudflare rate-limit bindings, single-use 24-hour invitations and owner-confirmed device revocation.
- Update dependencies and publication/history checks, keep self-hosted opt-in synchronization and signed update channels, and retain the new product homepage and documentation layout.

Desktop publication does not deploy the backend. Compatibility and verification boundaries: [main/PR integration](INTEGRATION-20261013.md) and [Windows integration](WINDOWS-INTEGRATION.md).

## 0.3.0-beta.4 - 2026-10-02

- fix: keep release Rust caches restore-only

## 0.3.0-beta.3 - 2026-10-02

- docs: teach Cockpit support skill signed update behavior
- fix: respect update channel changes and bound test workers
- fix: portable signed build config for Mac and Windows
- feat: signed updates from original GitHub release channels
- fix: allow unanswered comfort prompt to collapse
- fix: restrict control center window drag to header
- docs: identify project website as official website
- docs: add optional coffee support section
- docs: link creator's Bilibili video from READMEs
- docs: add Codex install and support skill with repository map
- docs: make README and release notes easier to read
- fix: emit cross-platform checksums and retain scan evidence on reruns
- fix: match release checksums to normalized asset names
- fix: reject skipped Defender scans and verify release artifacts

## 0.3.0-beta.2 - 2026-09-26

- test: make release checks independent of runner timezone

## 0.3.0-beta.1

- Clean source import, retaining upstream/font licenses.
- Configurable Cloudflare endpoint, create/join setup and custom members.
- Task/project-name sharing opt-in; OS-stored, server-scoped credentials.
- Self-hosting Skill, privacy guidance and Mac/Windows release pipeline.
- No author-owned sync service/runtime data; auto-update disabled.
