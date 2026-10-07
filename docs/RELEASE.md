# Codex 驾驶舱 · v0.3.0-beta.5

这是下一版的发布说明草稿，不表示安装包已经发布。实际可下载版本以 Releases 为准。这次补齐 GPT‑6.1 Sol 默认定价、本机实时用量对齐、增量扫描总量稳定和重置预警适配；保留签名自动更新与任务名称默认不共享。

云端增加嵌套快照白名单、流式请求大小限制、限流绑定及 owner 确认停用设备。管理员升级自己的 Worker 前必须把模板限流绑定合并到本地配置，缺失时 API 会返回 503；桌面更新不会自动部署服务器。

新增[产品说明书](USER-GUIDE.md)、AI 安装/答疑入口及[管理员维护指南](../skills/cloudflare-sync/references/maintenance.md)。普通用户只使用本机统计，或接受管理员邀请，不需要自己部署。收款码仍是完全自愿的咖啡支持入口。

驾驶舱把剩余额度、每日用量和估算成本放在一个小窗口里。你可以按任务、模型或成员查明细，翻看日历热力图，也可以选几项任务，把合计金额复制成一张小票。

[官方网站](https://codex-cockpit.pages.dev/) · [使用说明](https://github.com/HouSiyuan2001/codex-cockpit#readme)

## 下载哪个？

| 你的电脑 | 安装包 |
| --- | --- |
| Mac，Apple Silicon 或 Intel | 文件名以 `universal.dmg` 结尾 |
| Windows，x64 | 文件名以 `x64-setup.exe` 结尾 |

下载区的 `SHA256SUMS` 用来核对文件是否完整。`.sig` 和 `.app.tar.gz` 是自动更新使用的文件，手动安装不用下载它们。

## 装好后怎么用？

先看本机用量就可以，不需要部署服务器。想把几台电脑或几个人的用量放在一起看，再按照 [Cloudflare 自部署指南](https://github.com/HouSiyuan2001/codex-cockpit/blob/main/skills/cloudflare-sync/references/self-hosting.md)配置同步。成员名称、颜色和设备归属都可以自己设置。

## 安装前知道这几件事

- 这仍是测试版。仓库/Release 未公开时需要自己的访问权限手动下载；公开与发版由维护者另行确认。
- 新版需要分别记录 Mac 和 Windows 的安装与更新验收，自动构建不能代替实机测试。
- Mac 还没有 Apple 公证，Windows 还没有发布者签名，系统可能提示无法确认开发者。请核对来源与文件，不要关闭系统安全保护。
- 金额是估算，不是官方账单；仓库公开前仍需手动下载新版。更新密钥不放进 App，GitHub 登录密钥也不会放进 App。

<details>
<summary>查看上一版的构建和校验记录</summary>

- [Mac / Windows 构建与三时区测试](https://github.com/HouSiyuan2001/codex-cockpit/actions/runs/36225030684)。
- [Windows 安装包及程序扫描、下载校验表检查](https://github.com/HouSiyuan2001/codex-cockpit/actions/runs/36227341528)。扫描记录见 `WINDOWS-DEFENDER-v0.3.0-beta.2.json`。
- beta.2 安装包对应源码 `46cc00d`，没有被后续文档或发布流程修改替换。
- 早期校验表保留供追溯；下载核对请使用文件名匹配、兼容 Mac / Windows 的 `SHA256SUMS.txt`。
- Windows 验收是使用者反馈；Mac 暂未单独记录完整实机验收。自动检查和病毒扫描不能保证所有功能都没有问题。

</details>
