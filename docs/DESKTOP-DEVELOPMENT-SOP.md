# Quota Float desktop development SOP

This project is a Tauri desktop application. Website-only gates such as SEO, mobile breakpoints, and deployment URLs do not define release readiness.

## Before implementation

1. Read `README.md`, `docs/PROJECT-SUMMARY.md`, `docs/TEST-MATRIX.md`, and the relevant provider module.
2. Confirm the worktree state and preserve unrelated edits.
3. Define the user-visible outcome, credential/data boundary, failure states, and rollback.
4. Prefer existing Tauri, React, and Rust patterns before adding dependencies or sidecars.

## Implementation rules

- Keep provider credential access read-only and inside `src-tauri`.
- Never log tokens, account IDs, auth paths, or raw provider responses.
- Treat each provider as an isolated failure domain and preserve last-known-good data.
- Cover loading, healthy, stale, signed-out, unavailable, and partial multi-provider states.
- Keep browser preview data synthetic; validate real provider access only in Tauri.
- Use platform-specific behavior only behind explicit Windows/macOS boundaries.

## Fast handoff gate

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git diff --check
```

## Release gate

1. Run the fast gate.
2. Run `npm run version:check`.
3. Build the exact platform packages.
4. Scan the Windows executable and installer with `scripts/verify-windows-defender.ps1`.
5. Verify updater signatures separately from Authenticode/notarization.
6. Perform install, launch, update, rollback, and uninstall smoke tests.
7. Record any unsigned or unnotarized limitation plainly.

## Authorization boundary

Tests, builds, scans, and dry runs are non-publishing work. Commits, tags, pushes, releases, certificate changes, and external submissions require explicit user authorization.
