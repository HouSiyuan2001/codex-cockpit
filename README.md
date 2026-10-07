<div align="center">

# 🛸 Codex 驾驶舱

### 让 AI 放手干活，让你心里有数。

还剩多少额度？今天用了多少？哪个任务最能「吃」Token？<br>
把这些小问号，装进屏幕边上的一个小窗口。

[⬇️ 下载 Mac / Windows 版](https://github.com/HouSiyuan2001/codex-cockpit/releases/latest) · [✨ 看看它长什么样](https://codex-cockpit.pages.dev/) · [🎬 我榨干了 Codex](https://www.bilibili.com/video/BV1SXbv6REWz/) · [English](docs/README.en.md)

</div>

---

## 你的 Codex，小管家上线了 🐾

让 Codex 写代码、改论文、做项目的时候，最不想做的事，就是停下来翻记录、算用量。

驾驶舱替你把这些数字收拾好：平时是一只安静的小悬浮窗，需要时点开，就知道今天用了多少、接下来还有多少余量。少一点「会不会突然用完」的猜测，多一点专心做事的时间。

这是独立社区项目，不是 OpenAI 官方产品。

## 不只是几个数字

**🔋 余量一眼看懂**

剩余额度、重置时间、今日计划放在一起。今天放开跑，还是留一点给明天？不用来回翻页。

**🍪 看看谁最能吃 Token**

按任务、模型查看用量和估算成本，再翻翻日历热力图，看看自己和 AI 一起忙了些什么。

**🧾 给今天的工作打一张小票**

勾选几个任务，把合计用量和估算金额复制成小票风格的 PNG。写周报、分享项目，或者只是留个小纪念，都很顺手。

**🌈 找到舒服的使用节奏**

记录今天用起来是紧张还是宽裕，配合计划和提醒，慢慢摸清自己的节奏。数字是来帮忙的，不是来催你的。

**🏡 一个人很好用，一起用也可以**

先用本机统计，不用注册新账号，也不用部署服务器。想把自己的几台电脑放在一起看，或者和可信的小伙伴一起用，再开启可选同步。

[去官网逛逛 →](https://codex-cockpit.pages.dev/)（交互预览使用示例数据）

## 两步，带它回家

1. 打开 [最新版本下载页](https://github.com/HouSiyuan2001/codex-cockpit/releases/latest)：Mac 选 `universal.dmg`，Windows x64 选 `x64-setup.exe`。
2. 安装并打开，先从本机用量看起。云同步不是必填项，慢慢来就好。

需要的时候，在「设置 → 应用更新」检查新版；下载后由你确认重启安装。

> 安装前的小提醒：Mac 尚未 Apple 公证，Windows 尚未发布者签名。请核对下载来源和校验表，不要关闭系统安全保护。金额是估算，不是官方账单。

[📖 使用说明](docs/USER-GUIDE.md) · [🔒 隐私说明](docs/PRIVACY.md) · [💬 提问或反馈](https://github.com/HouSiyuan2001/codex-cockpit/issues)

## 请骰子喝杯咖啡 ☕

如果驾驶舱帮你少翻了几次记录、少操了一点心，欢迎投喂骰子一杯咖啡。谢谢你！量力而行，所有功能都不会因为有没有投喂而改变。

<a href="assets/support/dice-coffee.png"><img src="assets/support/dice-coffee.png" alt="支付宝收款码：投喂骰子一杯咖啡" width="360"></a>

<details>
<summary>🤖 不想自己装？让你的 AI 来帮忙</summary>

把这段话发给自己的 Codex：

```text
请帮我安装 Codex 驾驶舱：https://github.com/HouSiyuan2001/codex-cockpit
先读 skills/codex-cockpit/SKILL.md，根据我的系统选最新 Release 安装包，
核对文件后协助安装。保留已有设置，不部署服务器、不关闭安全保护。
```

[AI 安装与答疑](skills/codex-cockpit/SKILL.md) · [更多提示词](docs/CODEX-HELP.md)

</details>

<details>
<summary>🛠️ 给开发者、AI 和小团队管理员的资料</summary>

[文档导航](docs/README.md) · [参与贡献](.github/CONTRIBUTING.md) · [AI 工作入口](AGENTS.md)

同步由团队管理员在自己的 Cloudflare 账号下部署，成员接受邀请即可；作者不提供公共托管服务。同步适合互相信任的小团队，不是开放注册的公共 SaaS。共享数据可被空间成员和服务器管理者读取，非端到端加密；任务和项目名称默认不共享。

[Cloudflare 部署 Skill](skills/cloudflare-sync/SKILL.md) · [自动更新说明](docs/AUTO-UPDATE.md)

</details>

---

基于 [Quota Float](https://github.com/silverlion2/quota-float) 开发，采用 [MIT 许可证](LICENSE)。感谢上游作者与依赖维护者，也谢谢每一个愿意来试试的小伙伴。[第三方声明](docs/THIRD_PARTY_NOTICES.md)
