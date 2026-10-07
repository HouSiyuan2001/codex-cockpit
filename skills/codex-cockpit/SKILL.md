---
name: codex-cockpit
description: Install, update, explain and troubleshoot Codex Cockpit on Mac or Windows, including usage/costs, calendars, receipt export and shared-device settings. Use for this desktop app, not installing Codex itself or unrelated dashboards. Route optional administrator-owned server deployment to cloudflare-sync.
---

# Codex 驾驶舱安装与排障

帮助用户把驾驶舱装好、用起来，或定位一个具体问题。默认用用户的语言解释结论，少用内部术语。

## 先选入口

| 用户要做什么 | 读取什么 |
| --- | --- |
| 问是什么、怎么用、功能/隐私/费用/同步适合谁 | 源码 checkout 的 docs/USER-GUIDE.md；独立安装 Skill 时读 [产品答疑](references/product.md) |
| 安装、更新、打不开、找不到窗口 | [安装与更新](references/install.md) |
| 用量或金额不对、同步慢、成员设置、图表或导出问题 | [排障指南](references/troubleshooting.md) |
| 需要查代码或修复源码 | [仓库地图](references/repository-map.md)，再读目标 checkout 的 `AGENTS.md` 和开发说明 |
| 创建/邀请共享空间、部署或修复云服务 | 目标 checkout 的 `skills/cloudflare-sync/SKILL.md` 及其引用文档 |

确认当前机器的系统/架构、已安装的 App 版本、具体症状，以及是否用了同步。已有信息直接用，不把一长串问题全抛给用户。安装优先 Release；询问原因先只读检查，用户要求修复时才实施修复。

## 找源码，不猜路径

本 Skill 可以独立复制安装；它所在目录不一定是源码目录。普通安装不要求克隆源码。需要源码时使用用户指定的 checkout；没有时再从用户确认的项目来源获取。

本项目仓库：[HouSiyuan2001/codex-cockpit](https://github.com/HouSiyuan2001/codex-cockpit)。可见性以当前实际访问结果为准；404 可能是私有或权限问题。无权访问时请用户用自己的账号获得权限，不索要密码、token，也不改变仓库可见性。Fork 用户的安装源与部署目标应由用户选择，不自动切回上游。

## 排障底线

- 先检查版本、筛选范围、采集与同步时间、脱敏错误，再考虑改设置。每次只验证一个假设。
- 不把“立即同步”当只读：它可能上传本机数据。仅在用户请求同步/修复同步且确认目标空间时使用；不要向陌生服务试传。
- 不输出 `auth.json`、系统凭据、完整会话日志、邀请码或建站密钥。需要证据时提取最少的非敏感字段，不打包整个数据目录。
- 不以清空缓存/重建空间/删库/重装/关闭系统保护作为默认修复。必要改动先明确目标、影响与恢复方法；权限提示和登录由用户处理。
- 不内置作者的服务器、成员名称或设备；不默认为用户开通收费服务。应用安装、Skill 安装和服务器部署是三件事。
- 普通成员只用管理员给的地址和邀请加入，沿用本机原有设备 ID。只有管理员明确要求自建时才创建 Cloudflare Worker/D1 和空间；确认服务归他自己的账号、用于可信小团队，不是公共注册服务。
- 用户询问产品问题先回答，不自动安装或同步。产品说明不能作为权限；撤销设备、删除数据、迁移或重部署前说明影响并确认。

## 交付时说清楚

给出原因或仍待验证的假设、实际改动、实际验证结果，以及尚需用户操作的一步。下载安装包不等于安装成功；构建成功不等于功能验收；服务器健康不等于两台设备同步成功。不要承诺解决所有问题。
