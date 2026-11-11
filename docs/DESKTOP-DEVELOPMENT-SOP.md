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
- Use platform-specific behavior only behind explicit platform boundaries (Windows/macOS/Linux).

## Platform prerequisites

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt install -y build-essential libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev
  ```

Linux builds also need a running Secret Service provider (for example, GNOME Keyring
or KWallet with Secret Service enabled) for optional cloud credentials. The app does
not install or configure a provider. The provider may prompt to unlock its store;
failed access reports the existing credential-store error, without a plaintext
file fallback.

Linux uses X11/XWayland when `DISPLAY` is present and `GDK_BACKEND` is unset.
Explicit backend, input-method and WebKit launcher settings take precedence.
Native Wayland without XWayland keeps GTK defaults; it is not yet GUI-validated.

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
   Also run `npm audit --audit-level=moderate`, the Worker lockfile audit, `cargo audit --file src-tauri/Cargo.lock`, and `npm run audit:history`. Audit findings require explicit review; do not downgrade tools or suppress advisories just to pass.
2. Run `npm run version:check`.
3. Build the exact platform packages.
4. Scan the Windows executable and installer with `scripts/verify-windows-defender.ps1`.
5. Verify updater signatures separately from Authenticode/notarization.
6. Perform install, launch, update, rollback, and uninstall smoke tests.
7. Record any unsigned or unnotarized limitation plainly.

### macOS release signing

Configure these GitHub Actions variables and secrets before tagging a release.

| Setting | Where | Value |
| --- | --- | --- |
| `APPLE_SIGNING_IDENTITY` | Variable | Full `Developer ID Application: … (TEAMID)` identity |
| `APPLE_TEAM_ID` | Variable | Apple Developer team ID |
| `APPLE_CERTIFICATE` | Secret | Base64-encoded `.p12` containing the Developer ID Application certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Secret | Password used to export the `.p12` |
| `APPLE_ID` | Secret | Apple Account authorized to notarize for the team |
| `APPLE_PASSWORD` | Secret | App-specific password for that Apple Account |

Keep the same Apple team and bundle identifier (`app.codexcockpit.desktop`)
across updates and certificate renewals so macOS can recognize the app. On the
first upgrade from an ad-hoc build, macOS may ask to authorize the existing
cloud-sync Keychain item again. Smoke-test the next signed-to-signed upgrade
with cloud sync enabled to verify that the permission carries forward.

Untagged validation can use ad-hoc signing when the Apple settings are all
absent. Tagged builds require the Apple settings and verify the signed,
notarized app inside the updater archive. The Tauri updater key is separate
from the Developer ID certificate.

## Authorization boundary

Tests, builds, scans, and dry runs are non-publishing work. Commits, tags, pushes, releases, certificate changes, and external submissions require explicit user authorization.
