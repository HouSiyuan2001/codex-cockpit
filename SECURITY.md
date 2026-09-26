# Security

Report vulnerabilities privately to the maintainer; exclude active credentials/personal logs. Rotate exposed secrets at the issuer before removing files: deletion does not purge Git history.

This beta assumes a trusted small group. Members can read space usage and edit assignments/plans. Tokens are hashed at rest, invites expire/have use limits, and revisions prevent silent overwrites. These are not end-to-end encryption or a production security review.

Operators should restrict access, monitor Cloudflare quotas, configure edge rate limits, rotate secrets, back up D1 and test restores. Keep BOOTSTRAP_SECRET out of bundles/tracked config. Removing it after provisioning disables new-space creation, not existing invitations.

Before public registration/SaaS, review abuse/rate limiting, token lifecycle, audit logs, retention/deletion and operational support. No billing/availability guarantee.
