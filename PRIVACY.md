# Privacy / 隐私

## Local collection

The native app reads available provider credentials for read-only provider usage requests. It scans local session files/databases for usage events and task/project metadata. Session files can contain conversations: do not describe this as never opening history files. The collector extracts usage/metadata; sync does not upload conversation bodies, prompts or provider credentials. Derived usage, preferences and caches stay in the app's per-user data directory.

## Optional cloud sync

No shared usage server is contacted until you supply an HTTPS URL and create/join a space. Trust the operator: the setup secret/member token are sent to that chosen origin over HTTPS, with redirects disabled. Member credentials go in macOS Keychain / Windows Credential Manager under a server-specific key. The setup secret is not stored in app settings.

Shared data includes chosen display names, device IDs, assignments, usage dates/tokens/models/estimated prices, planning and comfort records. **Task/project names and task identifiers are shared only if enabled.** Active members and the Cloudflare account operator can read shared data; no end-to-end encryption. All joined devices may edit member assignments and plans; owner controls invites/pricing.

Turning off task sharing removes details from the next successful snapshot upload, not from offline caches/backups. Disabling automatic sync stops subsequent scheduled transfers, not deletion. Receipt clipboard export intentionally includes selected titles/totals.

Backend retains latest per-device snapshots plus settings/plans. Account/device deletion and token rotation lack a complete user UI: the operator must manage D1 deletion/revocation and backup retention. This beta suits small trusted groups, not an unreviewed public multi-tenant SaaS.

## Other network access

Provider requests go to the provider. Reset-risk data comes from the third-party public dashboard configured in `reset_forecast.rs`, without your usage payload; its operator sees ordinary request metadata such as IP. No dedicated analytics telemetry. Manual release links open GitHub. Legacy Git transport remains for compatibility but is not default onboarding.

Never publish runtime databases, provider files, local deployment IDs, personal screenshots or secrets. `audit:public` catches common mistakes but is not a full security audit. Do not post invites, tokens or setup secrets in issues.
