# 给 Codex 的仓库地图

这是查问题用的索引，不要求每次读完整仓库。下面的代码路径都相对 **Cockpit 源码根目录**；独立安装 Skill 后，先定位用户的 checkout。以正在排查的版本源码为准。

## 数据经过哪里

```text
Codex / Claude Code 登录 ───────→ Rust 查询额度 ─────────→ 额度、重置倒计时
Antigravity CLI 状态栏 ─────────→ Rust 读取两组额度 ──────→ 额度、重置倒计时
各 AI 的本机用量事件 ───────────→ Rust 采集、识别模型、估价 → 任务、Token、金额
                                             │ 可选跨设备同步
                                             ↓
                                      Cloudflare Worker + D1
                                             ↓
                      用量汇总、成员归属、共享配置、Claude / Gemini 额度快照
```

会话文件可能含对话内容；采集器读取它们来提取用量/元数据，不把对话正文放进同步载荷。不能宣传成“从不读取会话文件”。

新配置默认只开启 Codex。开启 Claude 或 Gemini 后，「用量」复用同一套「全局／成员」分组，一个成员可以包含多台设备。Claude 和 Gemini 同步每日用量汇总，任务明细留在本机。额度走单独的接口，只在空间所有者批准的同一成员设备间共享。

## 按问题找入口

| 要查什么 | 代码入口（相对仓库根目录） | 回归测试 / 设计说明 |
| --- | --- | --- |
| App 启动、悬浮窗、托盘、配置落盘 | `src/App.tsx`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json` | `src/lib/startup.test.ts`、`src/lib/windowTransition.test.ts`、`scripts/window-presence.test.mjs` |
| 控制中心与用户设置 | `src/components/ControlCenter.tsx`、`src/lib/preferences.ts`、`src/styles.css` | `src/components/ControlCenter.test.tsx`、`src/lib/preferences.test.ts` |
| 原生调用/浏览器演示区别 | `src/lib/bridge.ts`、`src/lib/tokeiBridge.ts`、`src-tauri/src/lib.rs` | `src/lib/bridge.test.ts`；浏览器使用虚构数据，不能证明原生凭据读取有效 |
| Codex 官方额度与登录 | `src-tauri/src/codex.rs`、`src/lib/officialUsage.ts` | Rust 模块内测试、`src/lib/officialUsage.test.ts` |
| Claude 官方额度、CLI 查找、重新登录 | `src-tauri/src/claude_quota.rs`、`src/hooks/useClaudeUsage.ts`、`src/components/ClaudeConnectionIndicator.tsx` | Rust 模块内测试、`src/lib/claudeCockpit.test.ts`；用 Claude Code 登录获取 5 小时与本周额度 |
| Gemini 两组额度、状态栏回调 | `src-tauri/src/main.rs`、`src-tauri/src/gemini_quota.rs`、`src/hooks/useGeminiQuota.ts`、`src/lib/geminiCockpit.ts` | Rust 模块内测试、`src/lib/geminiCockpit.test.ts`；分别读取 Antigravity 的 Gemini 和 Claude / GPT 模型组 |
| Token、模型识别、定价与任务去重 | `src-tauri/src/codex_project_usage.rs`、`src-tauri/src/tokei_usage.rs`、`src/lib/tokeiUsage.ts` | Rust 模块内测试、`src/lib/taskUsage.test.ts`、`src/lib/tokeiUsage.test.ts` |
| Claude / Gemini 用量采集与成本估算 | `src-tauri/src/claude_usage.rs`、`src-tauri/src/gemini_usage.rs`、`src/lib/claudeUsageRows.ts` | Rust 模块内测试、`src/lib/claudeUsageRows.test.ts`；估算按 API 等效成本，缺价保留未知 |
| 用量页、全局／成员分组 | `src/components/ControlCenter.tsx`、`src/components/UsageGroupSelect.tsx`、`src/components/CodexUsagePanel.tsx`（Codex / AI）、`src/components/ClaudeUsagePanel.tsx`（Claude / Gemini） | `src/components/CodexUsagePanel.test.tsx`、`src/components/ControlCenter.test.tsx` |
| 胶囊、展开布局和菜单栏额度 | `src/components/QuotaCard.tsx`、`src/components/ClaudeCockpit.tsx`、`src/lib/windowMetrics.ts`、`src/lib/menuBarQuota.ts`、`src-tauri/src/quota_tray.rs` | `src/components/QuotaCard.test.tsx`、`src/components/GeminiCockpit.test.tsx`、`src/lib/windowMetrics.test.ts`、`src/lib/menuBarQuota.test.ts` |
| 采集、上传、接收与旧 Git 兼容 | `src-tauri/src/usage_sync.rs`、`src-tauri/src/usage_sync_snapshot.rs`、`src-tauri/src/cloud_sync.rs`、`src-tauri/src/usage_sync_git.rs` | Rust 模块内测试、`docs/SYNC-CONTRACT-V2.md`；新用户可选接入 Cloudflare 共享空间 |
| 云同步界面、邀请、服务地址 | `src/components/CloudSyncSettings.tsx`、`src/components/UsageSyncPanel.tsx` | 各自 `.test.tsx`、`skills/cloudflare-sync/references/self-hosting.md` |
| 成员、设备归属、共享冲突 | `src/components/TeamMemberSettings.tsx`、`src-tauri/src/shared_settings.rs`、`src-tauri/src/cloud_sync.rs` | `src/components/TeamMemberSettings.test.tsx`、`cloud/usage-sync-worker/test/transport.test.mjs` |
| 跨设备任务明细 | `src-tauri/src/task_sync.rs`、`src/components/TaskUsageRow.tsx` | `src/components/TaskUsageRow.test.tsx`、`docs/TASK-SYNC.md` |
| Claude / Gemini 每日用量同步 | `src-tauri/src/provider_usage_sync.rs`、`src/hooks/useSharedProviderUsage.ts`、`cloud/usage-sync-worker/src/snapshot-schema.js` | Rust 模块内测试、`cloud/usage-sync-worker/test/transport.test.mjs`、`docs/SYNC-CONTRACT-V2.md` |
| Claude / Gemini 额度快照同步 | `src-tauri/src/claude_quota_sync.rs`、`src-tauri/src/gemini_quota_sync.rs`、`src-tauri/src/cloud_sync.rs`、`cloud/usage-sync-worker/src/claude-quota.js` | `src/hooks/useSharedClaudeQuota.test.tsx`、`cloud/usage-sync-worker/test/transport.test.mjs`；迁移见 `cloud/usage-sync-worker/migrations/0005_claude_quota.sql` 和 `cloud/usage-sync-worker/migrations/0006_gemini_quota.sql` |
| 用量圆环、趋势、日历 | `src/components/UsageChart.tsx`、`src/components/DailyUsageTrend.tsx`、`src/components/UsageCalendar.tsx`；对应 CSS | 同名 `.test.tsx`、`src/lib/usageCalendar.test.ts`、`src/lib/usageHeatmapColor.test.ts` |
| 日界与时间段 | `src/lib/usageDay.ts`、`src/lib/usageCalendar.ts`、`src-tauri/src/codex.rs`、`src-tauri/src/codex_project_usage.rs` | `src/lib/usageDay.test.ts`、`src/lib/tokeiRangeUsage.test.ts`；UTC+8 自然日/04:00 使用日与采集器本地日期不能混为一个口径 |
| 小票、撕纸交互与 PNG | `src/components/CustomTaskStatistics.tsx`、`src/lib/customTaskCard.ts`、`src/assets/fonts/` | `src/components/CustomTaskStatistics.test.tsx`、`src/lib/customTaskCard.test.ts` |
| 共享计划、个人手调 | `src/hooks/useSharedDailyPlan.ts`、`src/lib/sharedDailyPlan.ts`、`src/lib/personPlanSync.ts`、`cloud/usage-sync-worker/src/daily-plan.js` | 对应前端 `.test.ts`、`docs/SHARED-DAILY-PLAN.md` |
| 舒适度拟合、建议额度、风险 | `src/lib/personComfort.ts`、`src/lib/comfortFeedback.ts`、`src/lib/quotaPace.ts`、`src/components/ResetRiskQuotaHeatmap.tsx` | 对应测试、`docs/COMFORT-RECENCY-WEIGHTING.md`、`docs/REMAINING-QUOTA-PLAN.md` |
| Codex 重置观察与提醒铃铛 | `src-tauri/src/reset_forecast.rs`、`src/components/ResetWatchBell.tsx` | 模块内测试、`src/components/ResetWatchBell.test.tsx`、`docs/RESET-WATCH-BELL.md`；第三方监测，重置时间以官方额度窗口为准 |
| Worker 路由/权限、限流与快照校验 | `cloud/usage-sync-worker/src/index.js`、`snapshot-schema.js`、`request-body.js`（同目录）、`cloud/usage-sync-worker/migrations/` | `cloud/usage-sync-worker/test/`、`docs/SYNC-CONTRACT-V2.md`；维护见 `skills/cloudflare-sync/references/maintenance.md` |
| 下载更新、打包、签名与更新清单 | `src/lib/appUpdate.ts`、`src-tauri/src/app_updater.rs`、`scripts/release.mjs`、`scripts/updater-manifest.mjs`、`.github/workflows/release.yml` | `src/lib/appUpdate.test.ts`、`scripts/updater-manifest.test.ts`、`docs/RELEASING.md`、`docs/AUTO-UPDATE.md` |

## 各平台从哪里查

| 平台 | 原生代码与验证入口 |
| --- | --- |
| macOS | `src-tauri/src/capsule_glass.rs`、`src/hooks/useCapsuleGlass.ts` 管液态玻璃，`src-tauri/src/quota_tray.rs` 管菜单栏额度显示；CI 打包 Universal DMG |
| Windows | `src-tauri/src/claude_quota.rs` 查找 Claude CLI，`src-tauri/src/gemini_quota.rs` 管 Antigravity 状态栏命令；CI 构建 NSIS 安装器，通过 `scripts/verify-windows-defender.ps1` 扫描 |
| Linux | `src-tauri/src/linux_compat.rs` 管原生窗口兼容，`src-tauri/src/gemini_quota.rs` 处理 AppImage 路径和状态栏回调；CI 用 `scripts/verify-linux-package.sh` 验证 DEB 安装、启动与卸载，以及 AppImage 解包后启动 |

`codex/release-validation` 推送触发测试安装包构建。`v*` 标签触发正式或测试版发布和相应更新清单。平台打包、扫描和启动通过后，仍需在目标设备核对真实账号额度与共享空间同步。

## 本地状态和隐私边界

配置根目录由 `src-tauri/src/lib.rs` 的 `app.path().app_config_dir()` 决定，标识见 `src-tauri/tauri.conf.json`（当前为 `app.codexcockpit.desktop`）。运行时解析并验证，不写死作者的主目录或旧版应用目录。

| 状态 | 用途 / 读取边界 |
| --- | --- |
| `preferences.json`、`runtime-state.json` | 界面偏好及额度/计划运行状态；修复前在本机备份，不直接覆盖整份文件 |
| `usage-groups.json` | 成员与设备归属；修改应走 App/同步协议，避免绕过 revision |
| `cloud-sync.json`、`cloud-members.json`、`cloud-pull-status.json` | 服务/空间/设备配置与拉取状态；包含私有标识，不整份输出 |
| `usage-sync-state.json`、`usage-sync-local.json`、`cloud-snapshots/` | 采集/同步状态与本地、远端快照；只检查所需状态/覆盖率，不作为支持附件 |
| `claude-quota-latest.json`、`gemini-quota-latest.json` | 本机最近一次有效的额度观测，供额度同步上传；跨设备用量汇总仍从 `cloud-snapshots/` 读取 |
| `usage-prices.json`、`cloud-pricing.json`、`cloud-shared-settings.json` | 本地/空间价格与共享设置；查实际价格来源，不用本地覆盖破坏全组口径 |
| 系统 Keychain / Credential Manager / Secret Service | 服务与设备绑定的同步凭据，不能导出、日志打印或拷贝到其他设备 |

Codex 的数据路径可能由 `CODEX_HOME` 指定；核对正在使用的那份配置来源，不能修改该变量把用户迁到另一个 profile。传统 `.tokei` 支持仅是兼容层，排障不要要求新用户必须安装它。

## 怎么验证

从仓库根目录按相关模块选择命令；依赖安装与耗时完整构建要符合本次请求，不为读文档运行安装器。

```sh
npm test -- src/components/UsageCalendar.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml cloud_sync
npm --prefix cloud/usage-sync-worker test
npm run audit:public
git diff --check
```

修改源码后的完整检查见 `docs/DESKTOP-DEVELOPMENT-SOP.md` 和 `docs/TEST-MATRIX.md`。云测试用合成数据/内存数据库，真实客户端另做双向验证。文档修改验证链接、内容与隐私即可，不需要重打安装包。

## 维护地图

移动模块时同步修改本表；链接失效时先在目标版本用 `rg --files` 定位，不照旧路径猜着改。这里只存通用机制和合成示例，不保存使用者的问题日志或账号数据。
