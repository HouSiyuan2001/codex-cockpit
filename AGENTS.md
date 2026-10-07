# Codex Cockpit: start here

Codex Cockpit (Codex 驾驶舱) is a Tauri desktop app for macOS and Windows. Some internal names still say Quota Float. It is not the Codex app itself, a website deployment project, or a chat server.

## Find the right instructions

- Helping a user install, update or troubleshoot the app: read [the Cockpit support skill](skills/codex-cockpit/SKILL.md), then only the reference for that task.
- Finding code, storage boundaries or regression tests: read [the repository map](skills/codex-cockpit/references/repository-map.md). Paths there are relative to this repository, not the installed skill directory.
- Deploying or troubleshooting the optional server: read [the Cloudflare skill](skills/cloudflare-sync/SKILL.md). A local-only installation needs no server.
- User-facing prompts and skill setup: [让 Codex 帮忙](docs/CODEX-HELP.md).
- Product questions and usage: [产品说明书](docs/USER-GUIDE.md). Answer before taking actions; distinguish invited users from self-hosting administrators.

Prefer the installed release for ordinary installation. Do not turn a support question into a source rebuild, cloud deployment or data reset. First establish the installed version, platform and symptom. Distinguish an explanation request from permission to change anything.

## Development and release boundaries

- Read `docs/DESKTOP-DEVELOPMENT-SOP.md` before implementation, testing, packaging, or release work.
- Use the desktop SOP's fast handoff and release gates.
- Do not adopt or run the website SOP unless the task specifically concerns a separately deployed website.
- Preserve the local-first credential boundary: provider access stays read-only and inside `src-tauri`.
- Never copy auth files, session transcripts, keychain entries, real sync snapshots or local deployment configuration into an issue, commit or support bundle. Use synthetic fixtures.
- Keep missing costs distinct from zero, preserve shared-setting revision conflicts, and do not merge different people's manual plans.
- Treat commit, push, tag, release, signing, and external submission as separate authorization boundaries.
- Keep the repository private unless the maintainer explicitly approves changing visibility. A Skill is guidance, not permission to publish or change a user's security settings.
