# Codex Cockpit

Codex Cockpit is a local-first macOS companion for viewing quota status and daily usage without turning a simple glance into a full dashboard.

> Codex Cockpit is an independent, community-built project. It is not an official OpenAI product and is not affiliated with OpenAI.

## What it does

- Shows provider-reported quota snapshots, weekly remaining quota, daily usage, personal daily cap, and reset timing.
- Keeps the most useful status inside a compact capsule and opens a larger cockpit only when clicked.
- Expands inward from screen edges and corners so the expanded window stays close to the capsule.
- Supports light, dark, and system appearance, English and Chinese, adjustable font scale, and a background mode without a Dock icon.
- Provides a small local calendar for daily usage and comfort feedback when enough local history is available.
- Offers a quick link to external reset forecasts without mixing that service into the local quota calculation.

## Privacy first

Codex Cockpit is designed to keep personal usage data on the Mac:

- It does not read chat bodies, prompts, or conversation history.
- It does not store raw provider tokens.
- It does not operate accounts, redeem credits, or change provider settings.
- Daily history is derived locally from available quota snapshots and reset boundaries. Missing, stale, or incompatible data is shown as unavailable instead of being silently invented.
- The personal cap and planning slider are local display and planning preferences, not hard server-side limits.
- No separate telemetry or account-data upload is part of the project's intended behavior.

Provider response formats can change. Treat displayed values as snapshots with a visible data source and coverage boundary, not as a billing statement.

## Status

This repository is private while the project is being prepared for release. Source code, signed builds, and release notes will be published when the release is ready.

## Build from source

The public source tree will be included before the first public release. The expected development commands are:

    cd apps/quota-float
    npm install
    npm test
    npm run build
    npm run tauri build

A current Node.js release, Rust stable, and the platform dependencies required by Tauri 2 are needed for native builds.

## Contributing

Issues, design feedback, and pull requests will be welcome after the repository is opened. Please keep screenshots and logs free of account identifiers, access tokens, chat content, and other private data.

## Attribution and licensing

The first implementation builds on the open-source Quota Float project. The current product name, visual language, interaction model, and local features are independently redesigned for Codex Cockpit. Applicable upstream copyright notices and MIT license terms remain part of the source tree.

- Upstream project: [Quota Float](https://github.com/silverlion2/quota-float)
- Project code: MIT License
- Third-party assets: see their individual license files
