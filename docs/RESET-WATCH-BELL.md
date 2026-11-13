# 网站 Reset Watch 铃铛

通过 Rust 只读请求读取公开 API 的 `watch`。接受 level=elevated/strong 且在有效期内的预警。铃铛打开预警网页。有效的 `reset_chance` 自动填入现有风险滑条并用于今日建议。[Codex Resets API](https://codex-resets.com/api/resets)

同时识别 `/api/v1/status` 的 `scheduled_reset`：只接受来源、时间和状态通过校验的未来公告，作为“重置已宣布”铃铛显示，不伪造概率。到期、撤回或检查过旧后隐藏。

应用每 10 秒读取一次公开预警，额度快照刷新时更新已安排的重置。网站概率有效期间滑条跟随网站。预警过期、撤回或检查过旧时，计划恢复已有的手动值，或按近期直接补充额度的重置记录估算。

胶囊徽标不增加点击目标，仍点击展开；展开标题旁按钮阻止拖动冒泡，固定打开 https://codex-resets.com/，不使用上游任意URL。无 Watch 时不占位。

浏览器本地预览 ?watch=active 使用合成70% Watch；页面标明 synthetic，Tauri分支完全忽略该查询参数，始终走真实 API。不能把预览当作实时预警。
