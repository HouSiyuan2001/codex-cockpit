# Codex 驾驶舱

还剩多少额度，今天用了多少，都放在一个小窗口里。

[看看演示](https://codex-cockpit.pages.dev/) · [B 站视频](https://www.bilibili.com/video/BV1SXbv6REWz/) · [下载安装](https://github.com/HouSiyuan2001/codex-cockpit/releases) · [English](README.en.md)

Codex 驾驶舱是一个运行在 Mac 和 Windows 上的小工具。平时以悬浮窗待在屏幕一旁，点开后就能看额度、查用量、安排今天的使用计划，不必来回翻记录。

它是独立社区项目，不是 OpenAI 官方产品。

想先看视频？这里是我的 B 站分享：[《我榨干了Codex》](https://www.bilibili.com/video/BV1SXbv6REWz/)。

## 让 Codex 帮你装、帮你查问题

把下面这段发给自己的 Codex 就可以：

```text
请帮我安装 Codex 驾驶舱：https://github.com/HouSiyuan2001/codex-cockpit
先读 skills/codex-cockpit/SKILL.md，根据我的系统选 Releases 安装包，
核对文件后协助安装。保留已有设置，不部署服务器、不关闭安全保护。
```

仓库附有[安装与排障 Skill](skills/codex-cockpit/SKILL.md)、[Cloudflare 部署 Skill](skills/cloudflare-sync/SKILL.md)，以及让 Codex 知道“问题该去哪里查”的[仓库地图](skills/codex-cockpit/references/repository-map.md)。

经常使用的话，可以把 Skill 安装到自己的 Codex。具体方法和排障提示词见[让 Codex 帮忙](docs/CODEX-HELP.md)。目前仓库私有，Codex 也需要你自己的仓库访问权限。

## 可以用它做什么？

- **看还剩多少**：把本周剩余额度、重置时间和今日计划放在一起。
- **看用在哪里**：按任务、模型或成员查看 Token 和估算金额，用曲线与日历热力图翻看历史。
- **算几项任务的成本**：勾选想统计的任务，合计后复制成一张小票风格的 PNG。小票使用得意黑字体。
- **把几台电脑放在一起看**：Mac、Windows 的用量可以汇总到同一个空间。成员叫什么、用什么颜色、设备归谁，都由你设置。
- **找到自己的使用节奏**：记录每天用起来是紧张还是宽裕，配合计划和提醒调整用量。

想先看看长什么样，可以打开[演示网站](https://codex-cockpit.pages.dev/)。网页里的数据是演示数据，不会显示你的真实用量；实际功能以桌面 App 为准。

## 怎么安装？

打开 [Releases](https://github.com/HouSiyuan2001/codex-cockpit/releases)，下载与你的电脑对应的安装包：

| 电脑 | 下载哪个 |
| --- | --- |
| Mac，Apple Silicon 或 Intel | 文件名带 `universal.dmg` 的安装包 |
| Windows，x64 | 文件名带 `x64-setup.exe` 的安装包 |

安装后可以先使用本机统计，不需要先配置服务器。想共享数据时，再到设置里配置同步。

目前仍是测试版，仓库暂时保持私有，需要有仓库访问权限才能下载。更新时手动下载新版即可。

**安装提醒：** Mac 版还没有经过 Apple 公证，Windows 版还没有发布者签名，系统可能提示无法确认开发者。请先确认下载来源，并按 Release 里的说明核对文件；不要为了安装而关闭系统安全保护。

## 自己用，还是一起用？

**只在一台电脑上用：** 不需要 Cloudflare，也不需要部署服务器。

**想在多台电脑之间同步，或和其他人一起看：** 由一个人在自己的 Cloudflare 账号下部署同步服务，再创建共享空间、邀请其他设备加入。不需要每个人都部署一份服务器。

成员的作用很简单：决定一台设备产生的用量记在谁名下。一台设备归一个成员，一个成员可以有多台设备。成员名称、颜色和设备归属都可以自己改，已加入的设备也可以修改共享的成员设置。

照着[自部署指南](skills/cloudflare-sync/references/self-hosting.md)操作即可。也可以把仓库里的 [Cloudflare 部署 Skill](skills/cloudflare-sync/SKILL.md)交给编程助手，让它按步骤协助你申请和部署。

同步的是使用记录，不是 Codex 登录权限；加入空间不会自动获得别人的账号访问权。

## 数据和金额说明

- **金额是估算，不是官方账单。** 缺少价格或历史记录不完整时，会提示数据不完整，不把未知成本当成零。
- **不配置同步，也能在本机使用。** App 不内置开发者的私人同步服务器或成员名单。任务和项目名称默认不共享，需要你主动开启。
- **共享前确认谁能看到。** 同一空间的成员和服务器管理者可以查看共享数据；数据不是端到端加密的。不要把密钥放进聊天、截图或仓库。
- **计划和预警只是参考。** 驾驶舱不能替你改变官方额度，也不能保证额度什么时候重置。

更多信息见[隐私说明](PRIVACY.md)和[当前版本说明](docs/RELEASE.md)。

## 想自己改代码？

界面使用 React / TypeScript，桌面部分使用 Tauri / Rust，同步服务使用 Cloudflare Workers + D1。

需要 Node.js 24+、Rust stable，以及 [Tauri 对应系统的开发依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run tauri dev
```

运行测试：`npm test`。打包：`npm run tauri build`。

继续开发前可以看[开发说明](docs/DESKTOP-DEVELOPMENT-SOP.md)、[测试清单](docs/TEST-MATRIX.md)和[发布流程](docs/RELEASING.md)。浏览器预览使用虚构数据，不能代替桌面 App 的实机测试。

## 感谢与许可

项目基于 [Quota Float](https://github.com/silverlion2/quota-float) 开发，源码采用 [MIT 许可证](LICENSE)。感谢上游项目和所有依赖的维护者。

[得意黑 / Smiley Sans](https://github.com/atelier-anchor/smiley-sans)采用 OFL-1.1 许可证。完整信息见[第三方声明](THIRD_PARTY_NOTICES.md)。
