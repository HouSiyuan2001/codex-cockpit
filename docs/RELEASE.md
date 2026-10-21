# Codex 驾驶舱 · v0.3.2

- **新增 Linux x64 安装包**：整合 [PR #6](https://github.com/HouSiyuan2001/codex-cockpit/pull/6)，修复启动、输入焦点、窗口置顶与胶囊点击。感谢 @dailiuyi！
- **设置与更新更顺手**：精简设置，下载进度和失败重试集中显示。
- **跨设备任务更清楚**：折叠提示、历史筛选，缺失明细不再显示为零；同时更新安全依赖。

下载：Mac 选 `universal.dmg`，Windows 选 `x64-setup.exe`，Linux x64 选 `.AppImage` 或 Debian/Ubuntu 的 `.deb`。校验文件见 `SHA256SUMS`。

提醒：新加入空间默认共享任务明细，可提前取消；已有关闭设置不变。Mac 未公证、Windows 无发布者签名。Linux 原生 Wayland、混合 DPI 与完整跨设备验收仍待补齐；[安装说明](https://github.com/HouSiyuan2001/codex-cockpit/blob/main/skills/codex-cockpit/references/install.md)。
