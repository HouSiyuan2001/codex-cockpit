# Changelog

## 0.3.0-beta.5 - Unreleased

- Adapt Gitee main through 6f4fbba: GPT-6.1 Sol pricing, live local usage reconciliation, stable incremental totals, current reset-watch API and collapse after opening it.
- Keep GitHub self-hosting, opt-in task sharing and signed updater channels.
- Reject unknown nested snapshot/feedback fields; bound streaming JSON; require Cloudflare rate-limit bindings; use single-use 24-hour invite defaults.
- Add owner-confirmed device revocation without deleting recovery data.
- Update desktop/deployment tooling dependencies and add publication history/dependency checks.
- Add a user product manual, AI installation/Q&A routing and administrator maintenance guidance. Keep voluntary coffee support.

This is a source candidate, not a published installer or deployed backend.

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
