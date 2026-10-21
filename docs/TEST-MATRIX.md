# Test matrix

## 社区 PR 兼容整合

- 字体选项共七种；前后端识别并保存 `codex` / `yahei`，旧设置仍按平台默认回退。字体安装缺失时使用系统字体，不分发商业字体。
- Mac 菜单栏创建成功时使用 Accessory；失败时恢复 Regular 和任务栏入口。正常展开、收起与设置窗口仍可操作。
- 多个视图同时读取项目时仅执行一次采集；成功和失败之后都能重新读取，不永久缓存旧请求。
- 新用户无 Tokei / 云设置时使用稳定本机身份；默认“我”与全局视图都能显示任务和模型。不额外伪造另一份本机台账。
- 首次补扫显示部分覆盖；已有完整缓存不被补扫前缀覆盖。保留其他设备快照；未知金额、权限错误、损坏设置不填成零。
- 任务标题和价格诊断不降低完整 Token 的覆盖状态；具体适配与贡献来源见 [PR 整合记录](PR-INTEGRATION-20261012.md)。
- 已有缓存后遇到目录失踪、权限不足、无记录或读取异常，保留缓存并显示检查目录的入口；不输出原始错误或凭据。

## 新安装的金额估算（Mac / Windows 共用）

- 无 Tokei、无云配置时，内置价格覆盖 GPT-5.6 Sol/Terra/Luna、GPT-6 Astra/Sol/Luna 和 GPT-6.1 Sol。
- 三模型合成事件分别计价，总额 3.11 美元，任务和模型一致；再次扫描不重复累加。
- 兼容同一模型的 `openai/` 前缀；未知模型／代际标签仍未知，不猜变体。
- 保留自己的和共享空间的价格；升级后可补算旧的未知金额，不丢历史缓存。
- 缺价与缺少单次用量分别解释，不把未知算成零；272,000 / 272,001 输入的档位边界正确。
- 以上是自动回归场景；同学的真实记录和 Windows 原生验收仍需在对应设备确认。

## 首次安装和主题图标（Mac / Windows 同项验收）

- 不带旧配置、不加入云空间：自动生成本机身份与“我 / Me”，能显示本机用量并在重启后读取缓存。
- 找不到目录／目录不可读／无记录时给出对应解释和选择入口，不画假的零用量圆环；真实零记录正常显示 0。
- 选择目录后先确认读取；取消不写入设置、不扫描所选目录。切换目录后索引不串用。
- 完整缓存不被增量扫描前缀覆盖；本机统计不会更改现有人员归属或自动打开云同步。
- 日间／深色主题分别使用配对图标，圆弧与玻璃外沿平滑；安装包、旧快捷方式的静态图标可能仍被系统缓存。
- 两版底板都有圆角、透明四角与留白；白天版保留原版淡紫泡泡，Dock 不再显示整张方形底图。
- 手动读取与官方额度实机测试仍需有效 Codex 登录；单元测试和浏览器预览不能代替此项。

| Layer | Automated checks | Manual checks still required |
| --- | --- | --- |
| UI/calculations | `npm test`, `npm run build` | Themes, hover, calendar, receipt drag/clipboard |
| Rust | `cargo test`, `cargo check`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt -- --check` in src-tauri | macOS Keychain / Windows Credential Manager and provider sign-in |
| Worker | `npm --prefix cloud/usage-sync-worker test` with in-memory SQL migrations | Fresh D1 deployment and two actual clients |
| Privacy | `npm run audit:public` | New assets, screenshots/logs; no scanner guarantees absence of all secrets |
| Publication history/dependencies | `npm run audit:history`, `npm audit`, Worker `npm audit`, `cargo audit` | Commit author metadata, licensing and signing credential access |
| Release | Versions, Mac/Windows/Linux builds, Defender, SHA-256; Linux package install/startup/uninstall under Xvfb | Interactive desktop behavior, clean-machine install, clipboard, signed update and rollback |

Sync regressions: space isolation, single-use/expired invitations, device binding, stale snapshots, owner-only pricing/invites, member group CAS conflicts, independent personal plans, new-connection task-sharing default and explicit opt-out, preservation of old disabled preferences, invalid endpoints rejected before credential use.

Hardened Worker: nested aggregate/feedback allowlists, chunked UTF-8 request size bounds, rate-limit 429/Retry-After, fail-closed missing bindings, owner-only device revocation and cross-space denial. Existing operators must merge rate bindings before deployment; automated tests do not deploy or verify their actual edge configuration.

CI passing is not evidence all GUI smoke tests passed. Pre-releases identify outstanding manual checks and signing limits.

## Font/layout checks

Run `npm run dev`, then open `/scripts/typography-preview.html`. This preview uses
synthetic data only and does not change saved preferences. Check each font at
100%, 150% and 200%, in both languages and both themes. The Pro example pairs
`91%` with `118.4%`; the Plus example checks `100%` inside the smaller dual ring.
Numbers must stay centered and inside the rings. Explanations must remain readable
and wrap without dropping values or leaving a percentage on its own line.

System/YaHei/Times/FZ fonts depend on local installation; never bundle proprietary font
files. Browser checks do not replace macOS and Windows native-window smoke tests.

macOS Dock presence: launch the packaged app from Applications and confirm no Dock icon appears. Open/close the control center through the widget and menu bar, then relaunch and repeat. If tray creation fails, the app must retain its Dock/taskbar fallback so the window remains reachable. Also verify normal Windows tray behavior.
