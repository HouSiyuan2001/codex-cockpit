# Codex Cockpit

[中文说明](README.zh-CN.md)

A local-first **macOS and Windows** companion for Codex quota, usage, estimated cost and personal planning. Independent community software, not an OpenAI product.

## Features

- Compact floating widget and control center with light/dark themes.
- Token/cost charts, calendar heatmap, per-model/member/task breakdowns.
- Select tasks and copy a receipt-style PNG using Smiley Sans.
- Daily planning, reset-risk indicators and per-person comfort history.
- Optional self-hosted Cloudflare Workers + D1 sync. Choose your own server, space, names, members and device assignments. Any joined device can edit shared member assignments; conflicting edits require a reload.

Cost is an estimate, not a provider bill. Missing prices/partial history remain visible; unknown cost is not zero. Planning does not enforce provider limits. Reset forecasts are third-party estimates.

## Install

Download the macOS universal `.dmg` (Apple Silicon + Intel) or Windows x64 `-setup.exe` from this repository's **Releases**. Access is restricted while the repository remains private. Automation publishes only after both platform builds succeed.

The initial beta is **not Apple-notarized or Windows Authenticode-signed**. macOS uses ad-hoc signing. Verify the SHA-256 checksums and source before opening; security warnings are expected. Updates are manual. See [release limitations](docs/RELEASE.md).

## Use locally or self-host

Local usage needs no Cloudflare account. For sharing, follow [the self-hosting guide](skills/cloudflare-sync/references/self-hosting.md). A [deployment Skill](skills/cloudflare-sync/SKILL.md) is included: point your coding assistant at it, or copy the complete folder into its skill directory.

No author-owned sync endpoint, account, member list or credential is bundled. Joining is explicit. Task/project-name sharing is **off by default**. The server operator and invited members can read shared data; this is not end-to-end encrypted. Read [PRIVACY.md](PRIVACY.md).

## Develop

Requires Node.js 24+, Rust stable and [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm test
npm run build
npm run tauri dev
```

Native build: `npm run tauri build`. Worker tests: `npm --prefix cloud/usage-sync-worker test`. Publication audit: `npm run audit:public`.

Browser previews use synthetic data, not native credentials. See [SOP](docs/DESKTOP-DEVELOPMENT-SOP.md) and [test matrix](docs/TEST-MATRIX.md).

## Status and license

**Private during open-source preparation.** No workflow changes repository visibility. This is a cleaned source import, not personal development history or runtime data.

MIT, retaining the upstream [Quota Float](https://github.com/silverlion2/quota-float) license. Smiley Sans is OFL-1.1. See [notices](THIRD_PARTY_NOTICES.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md).
