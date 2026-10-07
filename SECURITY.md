# Security

Report vulnerabilities privately to the maintainer; exclude active credentials/personal logs. Rotate exposed secrets at the issuer before removing files: deletion does not purge Git history.

This beta assumes a trusted small group. Members can read space usage and edit assignments/plans. Tokens are hashed at rest, invites expire/have use limits, and revisions prevent silent overwrites. These are not end-to-end encryption or a production security review.

Workers require AUTH_RATE_LIMITER and API_RATE_LIMITER bindings and fail closed with 503 when missing. Limits are approximate and edge-local, not global billing/DDoS guarantees. Nested aggregate/feedback schemas reject unknown fields; JSON streams are bounded before decoding. Default invites expire after 24 hours with one use. Owners can explicitly revoke other devices; revocation is not erasure or recall of previously downloaded data.

Operators should restrict access, monitor Cloudflare quotas, configure additional edge protection as needed, rotate secrets, back up D1 and test restores. Keep BOOTSTRAP_SECRET out of bundles/tracked config. Removing it after provisioning disables new-space creation, not existing invitations. See skills/cloudflare-sync/references/maintenance.md for upgrade, revocation and deletion boundaries.

Before publishing, run npm audit for both lockfiles, cargo audit, audit:public and audit:history. Review commit author emails and binary assets manually. The coffee donation image is an intentional public support link, not a credential. Updater verification keys are public; signing private keys must remain in protected CI secrets. Pin/verify build dependencies and restrict publishing/signing permissions.

Before public registration/SaaS, review abuse/rate limiting, token lifecycle, audit logs, retention/deletion and operational support. No billing/availability guarantee.
