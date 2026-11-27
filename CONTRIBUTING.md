# Contributing · codex-cockpit

感谢参与贡献！提交前请先开 issue 描述场景/复现步骤；较大的功能请先确认方向，避免返工。

## 开发环境

- Node.js（版本与 `package.json` 的 `engines` 保持一致）
- Rust / Cargo（仅桌面壳相关改动需要）
- Tauri 依赖：见 [README.md](README.md) 的构建章节

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # Vite 开发服务
npm run build        # tsc + vite build（类型检查 + 构建）
npm test             # vitest run
npm run audit:public # 公开内容审计（不含真实路径/会话/密钥）
npm run tauri dev    # 桌面壳开发（需要 Rust 工具链）
```

## 提交要求

1. 新逻辑需补 Vitest 用例；修复 bug 请附复现步骤或回归用例；
2. 提交前至少通过：`npm run build`、`npm test`、`npm run audit:public`；
3. 不提交真实会话数据、本机路径、密钥或锁屏截图；
4. 涉及界面/交互的改动请附截图或录屏；
5. 一次 PR 聚焦一个主题，提交信息用祈使句（如 `fix: …` / `feat: …`）。

## 发布

发布流程见 `scripts/release.mjs` 与 `.github/workflows/release.yml`；版本号与 CHANGELOG 由维护者统一处理。

## 行为准则

尊重、务实、对事不对人；不接受带有真实用户数据的示例。
