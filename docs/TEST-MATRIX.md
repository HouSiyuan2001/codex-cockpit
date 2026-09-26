# Test matrix

| Layer | Automated checks | Manual checks still required |
| --- | --- | --- |
| UI/calculations | `npm test`, `npm run build` | Themes, hover, calendar, receipt drag/clipboard |
| Rust | `cargo test`, `cargo check`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt -- --check` in src-tauri | macOS Keychain / Windows Credential Manager and provider sign-in |
| Worker | `npm --prefix cloud/usage-sync-worker test` with in-memory SQL migrations | Fresh D1 deployment and two actual clients |
| Privacy | `npm run audit:public` | New assets, screenshots/logs; no scanner guarantees absence of all secrets |
| Release | Versions, Mac/Windows builds, Defender, SHA-256 | Clean-machine install, launch, clipboard, uninstall and rollback |

Sync regressions: space isolation, single-use/expired invitations, device binding, stale snapshots, owner-only pricing/invites, member group CAS conflicts, independent personal plans, task-sharing opt-in, invalid endpoints rejected before credential use.

CI passing is not evidence all GUI smoke tests passed. Pre-releases identify outstanding manual checks and signing limits.
