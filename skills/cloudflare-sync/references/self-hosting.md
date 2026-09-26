# 自建 Cloudflare 同步 / Self-hosting

## 准备自己的账号与源码

注册 [Cloudflare](https://dash.cloudflare.com/sign-up)，使用 Node.js 24+、本仓库源码及 Mac/Windows 客户端。此服务同步用量、成员、计划与体验，不是聊天服务器。无需购买域名，可用 Cloudflare 分配的 workers.dev 地址。

在仓库根目录运行：

```sh
cd cloud/usage-sync-worker
npm ci
npm test
npx wrangler login
npx wrangler whoami
```

浏览器登录由用户确认正确账号。不要读取浏览器凭据或把访问 token 复制到源码。

## 创建数据库与部署

```sh
npx wrangler d1 create codex-cockpit-sync
```

将 `wrangler.example.toml` 复制为同目录的 **wrangler.local.toml**（Git 已忽略）。macOS 可用 `cp wrangler.example.toml wrangler.local.toml`；PowerShell 用 `Copy-Item wrangler.example.toml wrangler.local.toml`；也可在编辑器复制。

只在本地配置中填写返回的 `database_id`、`database_name`，保留 `binding = "DB"`。Worker `name` 可自定义。已有服务先核对环境并备份，不重复创建或删除数据库。

```sh
npx wrangler d1 migrations list codex-cockpit-sync --remote --config wrangler.local.toml
npx wrangler d1 migrations apply codex-cockpit-sync --remote --config wrangler.local.toml
npx wrangler secret put BOOTSTRAP_SECRET --config wrangler.local.toml
npm run deploy
```

若自定义数据库名，命令也替换成自己的名称。`secret put` 提示时输入密码管理器生成的强随机密钥，保存在自己的密码管理器；不要放在命令行参数、聊天、截图或 Git 中。这是创建空间的建站密钥，不是邀请码或 Cloudflare API token。

记录部署地址（例如 `https://your-worker.your-subdomain.workers.dev`），访问 `/health` 应返回 `ok: true`。这只证明 Worker 可达，不证明数据库和桌面同步正常。

## 第一台电脑创建空间

控制中心 → 设置 → 云同步 → **创建共享空间**：填写自己的 HTTPS 服务域名（不带路径）、空间名称、建站密钥、显示名称。每台机器用不同设备标识，可用自动值；重连沿用原值。

任务/项目名称共享默认关闭，需要共享任务明细才开启。点击“连接并同步”；创建者是 owner，首位组员采用填写的名称。检查最近同步时间与计价配置。凭据存系统 Keychain / Credential Manager，不复制别人的配置文件代替邀请。

## 邀请其他设备和用户

创建者点击“邀请组员 / 新设备”，通过可信渠道发送**服务地址 + 邀请码**。邀请码默认 24 小时有效、只可使用一次。

对方“接受邀请”，填写同一地址、邀请码、自己的名字和不同设备标识。随后在“组员与设备”新增/改名，把机器归到实际使用者；同一人可有多台机器，一台机器只属一位组员。“默认查看谁”不等于把所有设备算给那个人。

所有已加入设备均可保存归属，并在其他设备下次拉取时生效。并发冲突提示刷新；邀请与统一价格表仍归 owner 管理。自动接收约每分钟、采集上传约每五分钟，不是实时聊天。“立即同步”用于验证。

验收：A 改组员 → B 收到，B 改 → A 收到；同一天 tokens/已知成本一致，未知价格保留缺失；开启任务共享后检查任务及设备标注。个人手动计划只改本人，不挤占另一个人的原分配。

## 隐私与维护

- D1 保存最新设备快照和共享设置/计划；成员/服务器操作员可读，不是端到端加密。不开任务共享仍共享用量、模型、显示名称和设备标识等。
- 关闭任务共享在下次成功上传移除任务明细，不撤回离线缓存/备份。删除数据、撤销设备当前需操作员管理 D1，尚无完整自助界面。
- 应用层每空间最多 32 台设备，单请求不超过 1 MiB。不是免费额度保证：查看 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) 与 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)，监控读写/请求/存储并配置限流。勿直接用于开放注册的公共 SaaS。
- 所需空间创建完后，可选 `npx wrangler secret delete BOOTSTRAP_SECRET --config wrangler.local.toml` 禁用继续建空间；原有邀请/同步不受影响。以后要建新空间再设置新密钥。
- 备份 D1、测试恢复，升级前审查迁移。桌面发版不自动部署后端。
- 日历/共享计划目前用 UTC+8 日界，暂不支持任意时区。

## 排障与验证边界

无权限：检查服务域名、邀请期限/次数、建站密钥。标识冲突：检查是否误用另一台机器标识，不复制凭据。成本缺失：owner 先立即同步，检查价格表、版本与覆盖率；不把未知当零。并发修改冲突时刷新再应用自己的变更。网络失败保留数据，不切换到不可信服务重试。

自动测试用内存 SQLite 验证迁移、空间隔离、邀请、快照与冲突，不访问真实账号。还需实际两台客户端验收；不能把 health 成功称为完整同步验证。

官方资料：[D1 入门](https://developers.cloudflare.com/d1/get-started/)、[迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Wrangler](https://developers.cloudflare.com/d1/wrangler-commands/)。
