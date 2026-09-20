# Agent Note: 采用上游 Desktop 应用

Status: implemented

[English](2026-09-13-adopt-upstream-desktop.md) | 中文

它发布的目标是[发布目标](2026-09-13-desktop-release-destination.zh.md)；本笔记所列差异中哪些已被上游取代，记录在[跟随上游的 Desktop 交付形态](2026-09-20-upstream-desktop-delivery-and-release-identity.zh.md)。

## 问题

桌面发行版需要 harness 在没有 Node.js、没有包管理器、也没有终端的机器上运行，而交付的 harness 假定的是反面：[`apps/cli`](../../../../apps/cli/README.zh.md) 从 profile 目录解析组合包、通过 Node 的模块解析按裸名挂载插件、安装会终止所在进程的处理器，并强制挂载交互式 HMR 服务。把 harness 跑在 Electron 主进程里同样不可行——终端能力会立即导入 `node-pty`，裸包名解析需要 Node 的内部 ESM loader，而启动器的故障处理会在一次未处理的 rejection 上终止整个应用。

本 fork 曾用自己的应用回答该问题：Electron-as-Node 壳、桌面组合包，以及每次部署后都要修复的闭包。与此同时上游构建了 `apps/desktop` 与 `apps/desktop-host`。同一产品的两套实现在所有关键维度上都已分叉——profile 格式、插件事务模型、恢复体验、更新单元，以及各自假定的 harness 部分——而每一侧的修复也只落在自己这一侧。

## 决策

本仓库的桌面应用即上游实现：`apps/desktop`（Electron 壳）与 `apps/desktop-host`（私有 Host 进程），其组合、profile、插件事务、恢复操作和更新单元保持原样。本 fork 的壳（`desktop/apps/shell`）、其组合包（`desktop/packages/bundle-desktop-app`）、其闭包根（`desktop/runtime-closure`），以及产出它们的两条构建入口（`desktop/build/package-app.mjs`、`desktop/build/build-closure.mjs`）均已删除。

本记录合并了组合决策（`2026-09-12-desktop-application-composition.md`，随本次改动一并删除）：该记录描述的是已删除的实现。

本 fork 自身工作中留存下来的，是与应用内部无关的全部内容：

- **发布身份。** Bundle ID、签名身份、公证凭据与发布仓库属于本 fork（[发布目标](2026-09-13-desktop-release-destination.zh.md)）。上游发布到它自己的 origin、凭据与 Bundle ID。
- **资源。** `desktop/build/icons` 与 `desktop/build/entitlements.mac.plist` 保留，打包配置把 `icon-dark.icns` 指定为 macOS 图标。上游同样自带图标，因此本 fork 的图标属于品牌选择，而不是在填补空缺。

本笔记最初保留的**运行时交付**——单个已验证归档展开到 `$DSH_HOME/closure/<版本>`——已经取消，休眠的 `plugin-store` 两个包随之删除：上游把依赖树打进 `app.asar`，并从自己的 Web 面板管理插件。[跟随上游的 Desktop 交付形态](2026-09-20-upstream-desktop-delivery-and-release-identity.zh.md)记录了本 fork 为何不再携带它们。

## 补丁面

`apps/desktop` 内的每一处 fork 改动都会成为下次上游同步的合并冲突，因此[desktop/README.md](../../../../desktop/README.zh.md)列出了全部补丁面，并让其尽可能小。补丁只剩发布身份一类（接受完整证书通用名的签名身份补丁、发布目标，以及它们各自触及的打包步骤）。

上游所有的 Agent Note 一律不动，包括本 fork 改变了其发布目标的[打包与更新决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)；本 fork 自己的记录会说明它在哪里不同。

## 考虑过的替代方案

- **保留本 fork 的应用，只选择性采用上游的包。** 否决：两套应用对 profile、插件生命周期和更新单元的建模不同，部分采用只会维护出第三套与两者都不匹配的设计。
- **同时保留两套应用供用户选择。** 否决：两个签名应用使用同一 Bundle ID、共享同一 `$DSH_HOME` 归属，无法共存；第二条安装路径还要把发布工作量翻倍，却不带来任何用户可见能力。
- **把上游应用作为固定副本 vendoring。** 否决：本 fork 已为仓库其余部分拉取上游 `master`，单独一个子树的 vendored 副本需要自己的同步流程，并且在交付补丁作用处仍会冲突。
- **把归档层贡献回上游，从而不带补丁。** 暂不采纳，理由不是价值而是条件：上游没有桌面 CI，此类打包改动无法在那里验证，而本 fork 现在就需要该交付。补丁面已被刻意收窄到将来可作为上游提案的规模。
- **把 harness 跑在 Electron 主进程里。** 随本 fork 自研应用一起否决，上游同样因"问题"中的三条理由不可采用；它还会让 harness 崩溃带走整个应用。
- **分发 SDK 运行时使用的那种 `pkg --sea` 单文件可执行文件。** 作为载体否决：它在 harness 与自身包树之间插入虚拟文件系统，把客户端 bundle 读取、`createRequire` 解析和 worker 入口路径都推到归档语义之后。它仍是 [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md)记录的回退方案。
- **由壳轮询判断就绪。** 否决：只有 harness 自己知道它的依赖树何时稳定，这正是私有 Host 报告结构化就绪记录的原因。靠猜测的壳会在组合尚未挂载完成时打开窗口。

## 影响

本 fork 跟随上游应用，并继承其 profile 格式、插件事务与恢复体验，包括仍标注为预发布的部分。应用更新跟随上游节奏，而交付形态与发布目标仍归本 fork。

本 fork 自研的应用代码已删除，连同固定它们的测试。其设计确立的约束依然成立，只是现在由上游维护：harness 绝不在 Electron 主进程中运行；打包应用携带真实的依赖树，而不是通过归档读取的树；窗口只在就绪握手之后打开，而不是按定时器打开。

发布差异带来上游没有的发布 workflow，并[由发布目标负责](2026-09-13-desktop-release-destination.zh.md)。交付差异已经消失：上游自己的打包取代了它，因此本 fork 现在跟随上游应用，首次启动不再展开任何东西。
