# Release process

`0.3.0-beta.1` is a private-repository preview, not a public launch.

Artifacts: macOS universal DMG (arm64 + x86_64), Windows x64 NSIS setup EXE and SHA256SUMS. Both platform jobs must pass before publication. No workflow changes repository visibility.

Mac uses ad-hoc signing, not Apple notarization; Windows is not Authenticode-signed. Defender does not establish publisher identity. No signed updater artifacts/automatic install. Verify source/checksums and follow OS security guidance, without disabling protection globally.

Automated checks do not replace clean-machine install/launch/clipboard/uninstall/rollback tests. Until separately recorded, packages are evaluation builds. No certificate purchase or paid cloud plan is required.

Use the release script's `--dry-run` for subsequent versions. It synchronizes npm/Cargo/Tauri versions. A matching `v*` tag triggers `.github/workflows/release.yml`, creating a pre-release only after checks/builds/scans. Do not silently replace existing assets.

Fork builds inject their own release URL with `VITE_RELEASE_URL`; self-builds without it do not open the original author's release page. Desktop tags never deploy Cloudflare.

References: [Tauri CI](https://v2.tauri.app/distribute/pipelines/github/), [Windows installers](https://v2.tauri.app/distribute/windows-installer/).
