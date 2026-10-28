# Codex 驾驶舱 · v0.3.4

- 今日用量区域精简为个人上限和今日总建议，同步状态在设置中查看。
- 修复跨重置的自然日用量累计，并根据最新账本重新计算历史个人分摊与舒适曲线，保留原有感受记录。
- 修复价格重算后旧缓存覆盖新账本的问题，部分缺价时继续保留已知金额。

下载：Mac 选 `universal.dmg`，Windows x64 选 `x64-setup.exe`，Linux x64 选 `.AppImage` 或 Debian/Ubuntu 的 `.deb`。校验文件见 `SHA256SUMS`。

个人分摊是共享额度的估算，数据覆盖不完整时会标记。Mac 未公证，Windows 无发布者签名；Linux 原生 Wayland 和混合 DPI 仍待完整验证。
