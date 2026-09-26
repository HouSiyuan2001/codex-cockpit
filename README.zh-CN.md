# Codex 驾驶舱

[English](README.md)

面向 **macOS / Windows** 的本地优先桌面工具：看额度、Token、估算金额和每日计划。独立社区项目，非 OpenAI 官方产品。

## 功能

- 悬浮胶囊与控制中心；浅色、深色主题。
- 用量曲线、日历热力图，按模型 / 组员 / 任务查看。
- 自选任务统计，复制得意黑字体的小票 PNG。
- 每日计划、重置风险与每人的舒适度记录。
- 可选 Cloudflare 自建同步：服务地址、空间、显示名称、组员与设备归属均由使用者配置。任何已加入设备都能修改组员；并发冲突时需刷新，避免静默覆盖。

金额是估算，不是官方账单。缺价和不完整数据会明确提示，不把未知金额当成零。计划不是服务方硬限额，外部重置预测仅供参考。

## 安装

在本仓库 **Releases** 下载 macOS 通用 `.dmg`（Apple Silicon / Intel）或 Windows x64 `-setup.exe`。目前仓库私有，需仓库权限才能下载。两个平台都构建成功后才发布。

首版为测试版：Mac 使用临时签名，**未做 Apple 公证；Windows 无 Authenticode 签名**。核对来源与 SHA-256 后安装，系统可能提示未知发布者。暂不自动更新，手动下载安装新版。详见[发布说明](docs/RELEASE.md)。

## 自建同步

只看本机数据不用 Cloudflare。多人同步请按[自建服务指南](skills/cloudflare-sync/references/self-hosting.md)申请自己的账号、部署 Workers + D1，在设置里创建空间并邀请其他设备。

仓库附带 [cloudflare-sync Skill](skills/cloudflare-sync/SKILL.md)，可让编程助手读取它协助部署，或将整个文件夹复制到助手的 Skill 目录。不要把密钥发到聊天或仓库。

不内置开发者私人服务器、成员或凭据。**任务 / 项目名称默认不共享**，需主动开启。共享数据对同空间成员和服务器管理者可见，不是端到端加密。参见[隐私说明](PRIVACY.md)。

## 源码构建

需要 Node.js 24+、Rust stable 与 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm test
npm run build
npm run tauri dev
```

打包：`npm run tauri build`。Worker 测试：`npm --prefix cloud/usage-sync-worker test`。发布前扫描：`npm run audit:public`。

浏览器预览使用虚构数据，不替代原生测试。参见[开发流程](docs/DESKTOP-DEVELOPMENT-SOP.md)和[测试矩阵](docs/TEST-MATRIX.md)。

## 开源准备

仍保持**私有**，不会自动公开。此仓库只含清理后的源码、测试、资源与文档，不导入个人开发历史、真实任务、截图、数据库或密钥。

源码 MIT，保留 [Quota Float](https://github.com/silverlion2/quota-float) 上游许可；得意黑 OFL-1.1。见[第三方声明](THIRD_PARTY_NOTICES.md)。
