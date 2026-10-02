# 发布维护说明

面向使用者的简介见[当前版本说明](RELEASE.md)。本文保留打包、扫描和校验的技术细节，供维护者参考。

`0.3.0-beta.2` is a private-repository preview, not a public launch.

Artifacts: macOS universal DMG (arm64 + x86_64), Windows x64 NSIS setup EXE and SHA256SUMS. Both platform jobs must pass before publication. No workflow changes repository visibility.

Release builds restore Rust caches when available but do not save them (`save-if: 'false'`). This avoids expensive post-job cache cleanup/compression blocking publication after the signed packages have already been uploaded. Tests, signatures and Windows security scans remain mandatory; a cache miss simply rebuilds dependencies.

Mac uses ad-hoc signing, not Apple notarization; Windows is not Authenticode-signed. Defender does not establish publisher identity. Updater archives/installers have a separate Tauri signature, checked before installation; this is not OS publisher signing. Verify source/checksums and follow OS security guidance, without disabling protection globally. See [automatic update setup](AUTO-UPDATE.md).

Automated checks do not replace clean-machine install/launch/clipboard/uninstall/rollback tests. Until separately recorded, packages are evaluation builds. No certificate purchase or paid cloud plan is required.

Use the release script's `--dry-run` for subsequent versions. It synchronizes npm/Cargo/Tauri versions. A matching `v*` tag triggers `.github/workflows/release.yml`, creating a pre-release only after checks/builds/scans. Do not silently replace existing assets.

Fork builds inject their own release URL with `VITE_RELEASE_URL`; self-builds without it do not open the original author's release page. Desktop tags never deploy Cloudflare.

Windows scan gates reject skipped/cancelled scans even if the scanner exits zero. Disposable GitHub-hosted runners have their built-in drive exclusions removed and archive scanning enabled before scanning; this mode refuses to run on personal or self-hosted machines. See [GitHub's image defaults](https://github.com/actions/runner-images/blob/main/images/windows/scripts/build/Configure-WindowsDefender.ps1). No exclusions are added and remediation remains enabled.

The `Verify existing Windows release` workflow can recheck a published installer's SHA-256, extract and scan its native executable, then attach a `WINDOWS-DEFENDER-<tag>.json` report. It never replaces existing release files. This supplies the actual scan evidence for beta.2 after discovering the original build runner skipped excluded files; the initial green build alone is not scan evidence.

For beta.2, use `SHA256SUMS.txt`: it preserves the original digests while matching GitHub's space-to-dot asset-name normalization, with LF line endings for macOS/Linux checksum tools. Earlier manifests remain for provenance. Future releases normalize names before checksumming.

References: [Tauri CI](https://v2.tauri.app/distribute/pipelines/github/), [Windows installers](https://v2.tauri.app/distribute/windows-installer/).
