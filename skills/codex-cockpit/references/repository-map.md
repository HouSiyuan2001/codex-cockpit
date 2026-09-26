# 给 Codex 的仓库地图

这是查问题用的索引，不要求每次读完整仓库。下面的代码路径都相对 **Cockpit 源码根目录**；独立安装 Skill 后，先定位用户的 checkout。以正在排查的版本源码为准。

## 数据经过哪里

```text
本机 Codex 登录状态 ─→ Rust 只读额度查询 ──────────────→ 剩余额度/重置显示
本机会话中的用量事件 ─→ Rust 采集、模型识别与估价 ─────→ 本机任务/Token/金额
                                                        │ 用户选择同步
                                                        ↓
                                        Cloudflare Worker + D1
                                                        ↓
                                    其他设备快照、组员、价格和计划
                                                        ↓
                                  前端按成员/任务/模型/日期汇总与呈现
```

会话文件可能含对话内容；采集器读取它们来提取用量/元数据，不把对话正文放进同步载荷。不能宣传成“从不读取会话文件”。

## 按问题找入口

| 要查什么 | 代码入口（相对仓库根目录） | 回归测试 / 设计说明 |
| --- | --- | --- |
| App 启动、悬浮窗、托盘、配置落盘 | `src/App.tsx`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json` | `src/lib/startup.test.ts`、`src/lib/windowTransition.test.ts`、`scripts/window-presence.test.mjs` |
| 控制中心与用户设置 | `src/components/ControlCenter.tsx`、`src/lib/preferences.ts`、`src/styles.css` | `src/components/ControlCenter.test.tsx`、`src/lib/preferences.test.ts` |
| 原生调用/浏览器演示区别 | `src/lib/bridge.ts`、`src/lib/tokeiBridge.ts`、`src-tauri/src/lib.rs` | `src/lib/bridge.test.ts`；浏览器使用虚构数据，不能证明原生凭据读取有效 |
| 官方额度/登录读取 | `src-tauri/src/codex.rs`、`src/lib/officialUsage.ts` | Rust 模块内测试、`src/lib/officialUsage.test.ts` |
| Token、模型识别、定价与任务去重 | `src-tauri/src/codex_project_usage.rs`、`src-tauri/src/tokei_usage.rs`、`src/lib/tokeiUsage.ts` | Rust 模块内测试、`src/lib/taskUsage.test.ts`、`src/lib/tokeiUsage.test.ts` |
| 采集、上传、接收与旧 Git 兼容 | `src-tauri/src/usage_sync.rs`、`src-tauri/src/usage_sync_snapshot.rs`、`src-tauri/src/cloud_sync.rs`、`src-tauri/src/usage_sync_git.rs` | Rust 模块内测试、`docs/SYNC-CONTRACT-V2.md`；新用户默认用 Cloudflare，不配置旧 Git 同步 |
| 云同步界面、邀请、服务地址 | `src/components/CloudSyncSettings.tsx`、`src/components/UsageSyncPanel.tsx` | 各自 `.test.tsx`、`skills/cloudflare-sync/references/self-hosting.md` |
| 成员、设备归属、共享冲突 | `src/components/TeamMemberSettings.tsx`、`src-tauri/src/shared_settings.rs`、`src-tauri/src/cloud_sync.rs` | `src/components/TeamMemberSettings.test.tsx`、`cloud/usage-sync-worker/test/transport.test.mjs` |
| 跨设备任务明细 | `src-tauri/src/task_sync.rs`、`src/components/TaskUsageRow.tsx` | `src/components/TaskUsageRow.test.tsx`、`docs/TASK-SYNC.md` |
| 用量圆环、趋势、日历 | `src/components/UsageChart.tsx`、`src/components/DailyUsageTrend.tsx`、`src/components/UsageCalendar.tsx`；对应 CSS | 同名 `.test.tsx`、`src/lib/usageCalendar.test.ts`、`src/lib/usageHeatmapColor.test.ts` |
| 日界与时间段 | `src/lib/usageDay.ts`、`src/lib/usageCalendar.ts`、`src-tauri/src/codex.rs`、`src-tauri/src/codex_project_usage.rs` | `src/lib/usageDay.test.ts`、`src/lib/tokeiRangeUsage.test.ts`；UTC+8 自然日/04:00 使用日与采集器本地日期不能混为一个口径 |
| 小票、撕纸交互与 PNG | `src/components/CustomTaskStatistics.tsx`、`src/lib/customTaskCard.ts`、`src/assets/fonts/` | `src/components/CustomTaskStatistics.test.tsx`、`src/lib/customTaskCard.test.ts` |
| 共享计划、个人手调 | `src/hooks/useSharedDailyPlan.ts`、`src/lib/sharedDailyPlan.ts`、`src/lib/personPlanSync.ts`、`cloud/usage-sync-worker/src/daily-plan.js` | 对应前端 `.test.ts`、`docs/SHARED-DAILY-PLAN.md` |
| 舒适度拟合、建议额度、风险 | `src/lib/personComfort.ts`、`src/lib/comfortFeedback.ts`、`src/lib/quotaPace.ts`、`src/components/ResetRiskQuotaHeatmap.tsx` | 对应测试、`docs/COMFORT-RECENCY-WEIGHTING.md`、`docs/REMAINING-QUOTA-PLAN.md` |
| 第三方重置观察 | `src-tauri/src/reset_forecast.rs`、`src/components/ResetWatchBell.tsx` | `src/components/ResetWatchBell.test.tsx`、`docs/RESET-WATCH-BELL.md`；不是官方保证 |
| Worker 路由/权限与数据库 | `cloud/usage-sync-worker/src/index.js`、`cloud/usage-sync-worker/migrations/` | `cloud/usage-sync-worker/test/`、`docs/SYNC-CONTRACT-V2.md` |
| 下载更新、打包、扫描 | `src/lib/appUpdate.ts`、`scripts/release.mjs`、`.github/workflows/` | `src/lib/appUpdate.test.ts`、`docs/RELEASING.md`、`docs/RELEASE.md` |

## 本地状态和隐私边界

配置根目录由 `src-tauri/src/lib.rs` 的 `app.path().app_config_dir()` 决定，标识见 `src-tauri/tauri.conf.json`（当前为 `app.codexcockpit.desktop`）。运行时解析并验证，不写死作者的主目录或旧版应用目录。

| 状态 | 用途 / 读取边界 |
| --- | --- |
| `preferences.json`、`runtime-state.json` | 界面偏好及额度/计划运行状态；修复前在本机备份，不直接覆盖整份文件 |
| `usage-groups.json` | 成员与设备归属；修改应走 App/同步协议，避免绕过 revision |
| `cloud-sync.json`、`cloud-members.json`、`cloud-pull-status.json` | 服务/空间/设备配置与拉取状态；包含私有标识，不整份输出 |
| `usage-sync-state.json`、`usage-sync-local.json`、`cloud-snapshots/` | 采集/同步状态与本地、远端快照；只检查所需状态/覆盖率，不作为支持附件 |
| `usage-prices.json`、`cloud-pricing.json`、`cloud-shared-settings.json` | 本地/空间价格与共享设置；查实际价格来源，不用本地覆盖破坏全组口径 |
| 系统 Keychain / Credential Manager | 服务与设备绑定的同步凭据，不能导出、日志打印或拷贝到其他设备 |

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
