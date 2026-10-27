# Codex 驾驶舱 · v0.3.3

- **支持 GPT-6.1 Terra 计价**：新增参考价格与长上下文档位；缺价记录继续保留未知状态。
- **跨时区统计一致**：Token、金额和日历统一按北京时间自然日统计，额度计划仍在北京时间 04:00 换日。
- **任务和模型总额一致**：两种视图使用同一份明细，切换视图不触发重扫；只有汇总的设备明确显示为未归属。
- **历史补扫更可靠**：修复超长非用量事件、可恢复的累计计数重置和已覆盖目录别名导致的错误覆盖提示，收起胶囊后也会继续分批补扫。

下载：Mac 选 `universal.dmg`，Windows x64 选 `x64-setup.exe`，Linux x64 选 `.AppImage` 或 Debian/Ubuntu 的 `.deb`。校验文件见 `SHA256SUMS`。

已有历史账本会继续保留。旧账高于当前可重建明细时，迁移保护会保持待迁移状态，不缩减旧账，也不把两份历史相加。金额为参考估算，并非官方账单。

Mac 未公证、Windows 无发布者签名。Linux 原生 Wayland、混合 DPI 与完整跨设备验收仍待补齐；[安装说明](https://github.com/HouSiyuan2001/codex-cockpit/blob/main/skills/codex-cockpit/references/install.md)。
