# 自动更新

更新包与源码放在同一个仓库：`HouSiyuan2001/codex-cockpit`。不会另外建公开仓库，也不会自动改变仓库可见性。

启动 12 秒后、运行中每 6 小时、断网恢复时检查更新。设置里可以手动检查，选择正式版或测试版，并关闭自动下载。下载完成并验证签名后会提醒重启；不会强制中断使用。安装前沿用现有设置备份流程。

仓库私有时，App 无法匿名下载更新清单，会提示来源不可用。暂时用已登录的浏览器从 Releases 下载。不要把维护者的 GitHub Token 放进 App 来绕过这个限制。仓库由维护者决定何时公开；公开并发布完整签名包后，同一更新地址即可使用。

## 维护者发布

- `TAURI_SIGNING_PRIVATE_KEY` 放在本仓库 Actions Secret，绝不提交到 Git。
- `src-tauri/tauri.conf.json` 只放对应公钥。私钥需独立安全备份；更换公钥会使已有安装无法验证新签名。
- `v*` 版本标签触发 Mac universal 和 Windows x64 构建；两个平台与扫描都通过后，发布安装包、签名、校验和与 `latest.json`。
- 测试版更新 `updates-beta/latest.json`，正式版更新 `updates-stable/latest.json`，不会相互覆盖。清单链接到不可替换的版本包；旧版本或同版本不会覆盖较新清单。
- Tauri 更新签名用于验证更新来源，不等于 Apple 公证或 Windows 发布者签名。首次安装仍需手动安装新版，旧 beta.2 不会凭空获得自动更新功能。

自己 fork 时，使用自己的签名密钥与配置公钥；发布工作流会将 `COCKPIT_UPDATES_REPOSITORY` 编译为 fork 的仓库地址。不能使用作者的私钥。

发布后还需用真正的 Mac 与 Windows 安装验收，测试从旧签名版本更新、无网、坏签名、保留配置和回滚。测试通过之前不要把“发布流程配置好了”称为“自动升级验收通过”。

参考：[Tauri 自动更新与签名文档](https://v2.tauri.app/plugin/updater/)。
