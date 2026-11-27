# Codex 驾驶舱 · v1.0.0

- 新安装默认只开启 Codex。可以在设置中开启 Claude 和 Gemini，升级会保留已有选择。
- Gemini 驾驶舱显示 Antigravity 的 Gemini 和 Claude / GPT 两组额度，各有 5 小时和本周窗口。Windows 和 Linux 同步支持读取额度。
- Codex、Claude 和 Gemini 的用量统计统一使用全局和成员分组。Claude 和 Gemini 支持在同一共享空间同步用量和额度。
- 优化多模型胶囊、菜单栏额度和重置倒计时。macOS 可在设置中开启液态玻璃。

自托管用户如需使用 Claude 和 Gemini 同步，请先应用数据库迁移并升级 Worker。[同步升级说明](https://github.com/HouSiyuan2001/codex-cockpit/blob/v1.0.0/docs/SYNC-CONTRACT-V2.md)

下载：Mac 选 `universal.dmg`，Windows x64 选 `x64-setup.exe`，Linux x64 选 `.AppImage` 或 Debian/Ubuntu 的 `.deb`。校验文件见 `SHA256SUMS`。

Mac 安装包未公证，Windows 无发布者签名。Linux 的 `.deb` 需手动更新。
