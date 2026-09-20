# Agent Note: 跟随上游的 Desktop 交付形态，只保留发布身份

Status: implemented

[English](2026-09-20-upstream-desktop-delivery-and-release-identity.md) | 中文

应用本体是[采用的上游应用](2026-09-13-adopt-upstream-desktop.zh.md)；本 fork 把发布放到哪里由[发布目标](2026-09-13-desktop-release-destination.zh.md)负责。

## 问题

本 fork 到 `0.1.6` 的上游同步以整包取上游 `master` 落地。上游已经替换掉了本 fork 一直在打补丁的那些东西：生产依赖树现在随 `app.asar` 分发，而不是 `resources/dsh` 散文件树；加载界面是 Web 应用自己的页面，而不是 Electron 文档；插件管理是 Web 面板；打包从目标 dotenv 文件读取发布设置，且从不回退到 shell 环境。

因此，本 fork 对上游文件的每一处改动都在合并中按上游解决：树是自洽的，但不可发布——`finalize-macos-channel.ts` 导入了两个已不存在的符号，发布 workflow 调用了一个已不存在的 `finalize:mac:channel` 脚本，而本 fork 自己的模块（运行时归档、MCP 包安装、诊断区块）没有任何调用方。

另一条路是把这些改动按原样重新应用，而它的代价在权衡期间还在增长：归档之所以存在，是因为上游在 `Contents/Resources` 里散放了 11000 个文件，而上游已经不再这样做了。重新应用它，等于重建一个前提已被上游移除的机制，并把它触及的承重文件（`main.ts`、`prepare-dsh.ts`、electron-builder 的资源映射）变成以后每次同步的永久冲突。

## 决策

本 fork 跟随上游的交付形态，只保留必须自己拥有的部分。

**从上游采纳。** 运行时随上游打包的方式分发。本 fork 曾扩展过的那些 Electron 文档重新变回上游的，因此首次启动展开、其进度界面、恢复页与更新流程都是上游交付的版本。

**丢弃，不再携带。** `apps/desktop/src/runtime-closure.ts` 及其测试；`apps/desktop/src/mcp-bundles.ts`、其测试与 fixture；`apps/desktop/src/diagnostics.ts` 及其测试。其中两个界面早已失去落脚点——上游删除了 `renderer/plugin-manager.*` 与 `renderer/startup.*`，而那正是本 fork 挂载它们的位置——因此继续携带就意味着要对着上游的 Web UI 重建它们，而不是直接交付。休眠的 `desktop/packages/plugin-store` 与 `desktop/packages/ui-plugin-store` 一并删除，因为它们所记录的能力已不再在本仓库任何地方表达。

**保留，因为本 fork 仍然拥有。** 发布目标：`ceasarXuu/deepseek-harness-desktop` 中的 GitHub release；一份指明该仓库与发布类型的 `app-update.yml`；对 DMG、ZIP 与 blockmap 的带校验上传；以及一个把两个架构的 ZIP 合并为单份 `<channel>-mac.yml` 的 finalize 步骤，因为一次 release 只携带一份频道文件。上游发布到腾讯 COS 并使用本 fork 不持有的凭据，所以这是唯一无法丢弃的差异。macOS 证书仍可按完整通用名提供，因为本钥匙串中有两张共用短名的证书。深色应用图标仍由打包配置指定；上游现在自带图标，因此这一项是品牌选择，而不是在填补空缺。

**移入发布 workflow。** 发布设置通过 `apps/desktop/.env.macos` 到达打包流程，由 workflow 在打包前从其 secret 写出。workflow 不再自行把签名证书导入钥匙串：打包命令会用 `CSC_LINK` 创建临时钥匙串，并在运行结束时删除。

## 考虑过的替代方案

- **把运行时归档重新应用到上游 0.1.6 上。** 否决：上游把依赖树打进 `app.asar`，11000 个散文件的前提已不存在，而且重新应用会触及上游改动最频繁的文件。
- **保留本 fork 自己的界面，并在上游 Web UI 上重新表达。** 本次否决，而非在价值上否决：在任何东西可见之前，需要先有 client 包、IPC、preload 桥与两份语言词典，而发布并不依赖它。这些界面记录过的决策已归档，若日后再需要该能力仍可查阅。
- **发布到上游的腾讯 COS 目标。** 否决：它需要本 fork 不持有的凭据，且该源提供的是上游的构建。
- **把本 fork 的 `app-update.yml` 写入器与上游的并列保留。** 否决：两个模块写同一个文件，意味着其中一个会在无人察觉的情况下不再拥有它。上游的 `macos-app-update-config.mjs` 拥有它，并改为写入 GitHub provider。

## 后果

本 fork 在 `apps/desktop` 内的补丁面只剩发布身份，因此下一次同步要解决的冲突更少。从更早的 fork 版本安装的应用仍能继续更新：频道文件名仍由版本的预发布段推导，因此 `0.1.5-rc.3` 依然读取 `rc-mac.yml`，而本 fork 依然发布它。

被移除的能力可以从删除它们的那次提交取回，而不是在此重新表达。本 fork 不再从自己的窗口安装 `.mcpb` 包，不再显示诊断区块，也不再在首次启动时展开已验证的运行时。
