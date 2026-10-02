# Codex 驾驶舱 · v0.3.0-beta.3

这次为 Mac 和 Windows 加上了自动更新：设置里检查新版，下载并验证签名后，由你确认重启安装。仓库仍为私有，App 暂时无法直接下载；旧版也需要先手动安装一次。

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

- 这仍是测试版，仓库暂时保持私有。
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
