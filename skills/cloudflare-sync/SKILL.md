---
name: cloudflare-sync
description: Deploy or troubleshoot the Codex Cockpit self-hosted Cloudflare Workers and D1 sync service, then connect user-owned desktop devices. Use for Cockpit backend setup and invitations, not unrelated Cloudflare projects.
---

# Codex Cockpit self-hosting

Read [references/self-hosting.md](references/self-hosting.md) before setup or troubleshooting. It contains repository layout, commands, first-space setup and verification. If this skill was installed separately, locate the user's Cockpit checkout; do not assume it is beside the installed skill.

First distinguish the operator from an invited user. Only an explicitly authorized administrator creates resources in their own account; an ordinary invited user needs only the selected origin and invitation, not another deployment/space. This is optional infrastructure for a trusted small team, not a public registration service. For revocation, deletion, restore or upgrading the hardened Worker, read [references/maintenance.md](references/maintenance.md) and confirm the specific affected resources and action.

Use the user's own Cloudflare account and selected Worker/D1 database. Check `wrangler whoami` without copying account identifiers into artifacts. Before changing an existing service, inspect configured resources and migration state. Never redeploy another operator's endpoint or create duplicate resources as a retry.

Keep configuration in ignored `wrangler.local.toml`. Use interactive `wrangler secret put BOOTSTRAP_SECRET`; never ask for secrets in chat, print them, put them in command arguments or commit them. Account signup/login stays interactive. Do not select a paid plan unless requested.

Keep task-name sharing off by default. Explain that joining shares usage/plans/comfort with the chosen server and members, readable by the operator. Never upload real conversations, provider tokens or private app data for smoke tests.

Verify migrations, Worker health, first owner, second invited device, bidirectional group edits, conflicts and coverage separately. Deploy/health success is not desktop sync verification. Use synthetic automated test data. If interactive login or a second device is unavailable, say which checks remain.

Conclude with endpoint, resource names (not secrets), revision and verified checks. Do not change repository visibility. Desktop release publication is separate from backend deployment.
