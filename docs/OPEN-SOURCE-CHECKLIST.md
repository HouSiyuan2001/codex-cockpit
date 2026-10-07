# 开源前最后核对

公开源码、提交推送、打版本标签、发布安装包和部署 Worker 是独立步骤，分别由维护者授权。0.3.0-beta.5 当前是源码候选；不能用 main 的检查结果代替已下载安装包的身份或 GUI 验收。

## 源码与文档

- 比较 Gitee main 与 GitHub 当前基线，选择移植功能，不整仓覆盖私人开发记录/配置；本轮基准 Gitee 6f4fbba，GitHub 8b3771a。
- 运行完整桌面快速门禁、Worker 测试、版本一致性和 diff 检查。
- 扫描两个 npm lockfile 和 Cargo.lock；保留真实告警，不用降级、忽略项或删除依赖来伪造零风险。
- Cloudflare 工具使用 Wrangler 4.148.0，并以 sharp 0.35.5 的补丁版本 override 修复其传递依赖漏洞；每次升级复查兼容性与审计，不长期把 override 当安全保证。
- 本轮 Cargo.lock 已把 rustls 升至 0.23.45、event-listener 升至 5.4.2。RustSec 仍有 6 项上游 unmaintained 提示（proc-macro-error 与 5 个 UNIC 包）及 GLib 0.18.5 的 unsound 提示。GLib 不在已检查的 Apple Silicon macOS / Windows x64 目标依赖树中，但仍保留在跨平台 lockfile；若以后支持 Linux，必须重新处理，不能照搬当前结论。UNIC 属于 Tauri 的传递依赖，不以未经审查的 fork 或破坏性替换来隐藏告警。
- 运行 audit:public 与 audit:history。规则扫描只能找常见模式；人工检查新增图片、提交作者邮箱、外链及许可。
- 收款码是维护者明确选择的咖啡支持入口，保留。更新公钥不是私钥。MIT、OFL 和上游声明随源码分发；不把供应商品牌当作官方背书。
- Git 历史有非 noreply 提交邮箱，公开后会可见；由维护者确认接受或另行授权历史重写，不能自动抹除历史。
- 仓库可见性和访问权限以实际页面为准；README 的条件说明不表示已经公开。

## 安装包与服务

- 安装包使用新版本号，签名更新包、SHA256SUMS 与目标 tag/源码对应，不替换旧版本资产。
- 记录 Mac / Windows 首装、实际启动版本、更新、回退、卸载与相关界面验收。Mac ad-hoc / 未公证、Windows 无 Authenticode 的限制如实说明；Updater 签名不等于系统发布者签名。
- 公开之前确认 GitHub signing secret 只用于受保护的发布任务，限制仓库写权限，不在不可信 PR 上运行带发布权限的构建。
- 外部 GitHub Actions 固定到已核验的完整 commit SHA。现有 Windows Release 复扫工作流仅手动运行；推送源码不自动向旧 Release 附加文件。
- 各团队管理员自行部署到自己的 Cloudflare 账号：备份、迁移、限流、权限和恢复均由其负责。此仓库不提供公共同步托管服务，不开公共注册。
- 严格 schema / 限流 / 停用是防护，不是完整安全认证或端到端加密。完整账号删除、owner 凭据轮换、缓存/备份撤回仍需操作员管理。
- 新服务器验证两台客户端的新上传/接收及归属；本地自动测试不证明现有云服务已升级。
