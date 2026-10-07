# 让你的 Codex 帮忙

不必先学会打包和部署。你可以把问题直接交给自己的 Codex，让它读仓库里的说明，再协助操作。

## 安装驾驶舱：复制这段就行

```text
请帮我安装 Codex 驾驶舱：https://github.com/HouSiyuan2001/codex-cockpit
先读取仓库里的 skills/codex-cockpit/SKILL.md 和安装指南，确认我的系统与架构，
从 Releases 选择合适的版本并核对校验值，再协助安装和首开检查。
保留我已有的设置，不要部署服务器或关闭系统安全保护。
如果仓库没有访问权限或需要我登录，请停下来告诉我。
```

这是安装 **驾驶舱 App**，不是安装 Codex 本身。只用本机统计，不需要 Cloudflare。

## 经常用：把 Skill 装进自己的 Codex

仓库有两个独立的 Skill：

| Skill | 帮你做什么 |
| --- | --- |
| [`codex-cockpit`](../skills/codex-cockpit/SKILL.md) | 安装/更新 Mac、Windows App；读产品说明回答问题；排查额度、金额、图表、小票和设备同步 |
| [`cloudflare-sync`](../skills/cloudflare-sync/SKILL.md) | 仅供管理员在自己的 Cloudflare 账号部署可信小团队服务、创建空间、邀请和管理设备 |

可以直接对 Codex 说：

```text
请用 $skill-installer 从 GitHub 仓库 HouSiyuan2001/codex-cockpit
安装 skills/codex-cockpit 到我的 Codex。
这次只安装 Skill，不安装 App，也不部署服务器。
如果已有同名 Skill，请先比较，不要覆盖我自己的修改。
```

管理员需要自建同步时，把路径换成 `skills/cloudflare-sync` 即可；普通成员只接受邀请，不需要部署。仓库未公开时需要自己已有的 GitHub 访问权限；不要把密码或 token 发给 Codex。

也可以手动复制完整的 Skill 文件夹（包含 `references` 等子目录），Mac 放进 `~/.agents/skills/`，Windows 放进当前用户目录下的 `.agents\skills\`。仓库中的 `skills/` 是分发目录，不会仅因克隆就自动成为个人 Skill；在仓库中工作时，`AGENTS.md` 会指向它。避免把同名 Skill 重复装进多处。Codex 没显示新 Skill 时，重新启动后检查。依据：[官方 Skill 说明](https://learn.chatgpt.com/docs/build-skills)。

安装后就可以这样说：

```text
用 $codex-cockpit 看一下驾驶舱为什么有 Token 但没有金额。
先只检查原因，不改我的设置，不上传日志。
```

或：

```text
用 $codex-cockpit 帮我修复两台电脑的用量同步。
先确认是否在同一空间，再检查采集、上传和接收分别卡在哪一步。
保留原有数据；需要改服务器或重新加入空间时先告诉我影响。
```

## 问怎么用：复制这段

```text
请用 $codex-cockpit 解释驾驶舱的用量、金额、成员和日历怎么用。
先读产品说明书 docs/USER-GUIDE.md；独立 Skill 可读 references/product.md。
这次只回答问题，不安装、不改设置、不上传数据、不部署服务器。
```

## 加入已有团队：不另建空间

```text
请用 $codex-cockpit 协助我加入管理员已有的驾驶舱共享空间。
先解释会共享哪些数据、谁能看到，确认我信任这个服务。
沿用这台电脑原有设备 ID；服务地址和邀请由管理员提供，我在 App 中填写。
不要复制其他设备身份令牌，不另建空间，不配置旧 Git 自动同步。
完成后核对组员归属、实际上传时间和另一台设备的新快照。
```

## 我是管理员：自建服务

```text
请用 $cloudflare-sync 协助我在自己的 Cloudflare 账号里部署驾驶舱同步。
只用于我邀请的可信小团队，不开公共注册。
先检查已有资源和备份，按指南配置限流、迁移和建站密钥；登录和密钥输入由我处理。
创建一次空间后用邀请加入其他设备，逐项验证上传、接收和归属。
不部署到作者或其他团队的服务器，不开通付费计划，不发布仓库或安装包。
```

## 给 AI 的说明地图

[`AGENTS.md`](../AGENTS.md) 是入口，[仓库地图](../skills/codex-cockpit/references/repository-map.md)把常见问题对应到代码、数据位置和测试；[排障指南](../skills/codex-cockpit/references/troubleshooting.md)说明先查什么、如何验证。

[产品说明书](USER-GUIDE.md)解释功能、限制和常见问答。其他能读 Markdown 的 AI 也可以使用这套说明，但不要假设它具备 Codex 的安装工具或系统权限。

没有源码也可以按 Skill 安装或检查界面。需要深入查代码时，再获取有权限的源码 checkout；不要要求普通用户一上来装全套开发环境。

Codex 能做的事情取决于它在你电脑上的工具和权限。登录、系统确认、另一台设备的实际检查可能仍需要你操作；它不能仅凭构建成功就保证所有功能正常。请不要提供完整会话、凭据文件、邀请码或数据库来“方便排障”。
