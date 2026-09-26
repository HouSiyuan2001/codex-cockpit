# 网站 Reset Watch 铃铛

通过既有 Rust 请求读取 [公开 API](https://codex-resets.com/api/docs) 的 GET /api/v1/status；以 active_watch 非空、level=elevated/strong、可解析的 observed_at/expires_at 和尚未到期为准，不设概率阈值。概率允许 null。第三方 AI 分类预测不是 OpenAI 承诺。

仅传递 level、概率、观测/到期时间和本地 watchCheckedAt，不存推文或账户数据。铃铛独立于校准 score 与手动风险滑条，不改变额度或舒适曲线。沿用5分钟原生后台额度事件、启动/聚焦/手动刷新；请求失败或撤回立即清除，下次30秒规划时钟清除到期信号；10分钟没有成功检查也隐藏。不申请系统或浏览器通知。

胶囊徽标不增加点击目标，仍点击展开；展开标题旁按钮阻止拖动冒泡，固定打开 https://codex-resets.com/，不使用上游任意URL。无 Watch 时不占位。

浏览器本地预览 ?watch=active 使用合成70% Watch；页面标明 synthetic，Tauri分支完全忽略该查询参数，始终走真实 API。不能把预览当作实时预警。
