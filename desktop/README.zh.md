# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的桌面发行版：一个已签名、自包含的 macOS 应用，无需终端、无需系统 Node.js，也无需单独启动任何服务，即可运行 harness 及其浏览器界面。

应用本体来自上游——`apps/desktop`（Electron 壳）与 `apps/desktop-host`（私有 Host 进程）。本子树记录本 fork 在它周边改了什么、从自研实现中保留了什么，以及一次发布如何产生。[采用决策](../.agents/notes/implemented/architecture/2026-09-13-adopt-upstream-desktop.zh.md)负责说明原因。

## 与 harness 的关系

外壳从应用携带的运行时启动私有 Host 进程，该进程挂载与 `dsh --profile web` 相同的插件树。有三条 harness 事实塑造了此处的全部设计决策，它们各自由声明它的包负责，而非本子树：

- 裸包名插件解析需要 Loader 访问内部模块（[`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)）。
- 默认持久化后端会立即导入 `node:zlib` 的 zstd，会话搜索索引则导入 `node:sqlite`（[`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.zh.md)）。
- 终端能力会立即加载 `node-pty` 原生 addon（[`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.zh.md)）。

## 开发模式

本仓库是 `deepseek-ai/deepseek-harness` 的长期 fork。开发在此进行；上游 `master` 只用于拉取更新。为桌面应用开发的内容一概不回贡上游。

这一安排让一个性质成为关键：**拉取上游的成本，与本 fork 改动多少上游文件成正比。** 每个被改动的上游文件都会在下次同步时变成合并冲突，因此桌面侧的工作优先新增文件，只在交付或发布身份确实需要时才修改既有文件。

### 本 fork 改动的上游文件

往这张表里加一行是一个决策，而不是副作用。

| 文件 | 改动 | 为何无法避免 |
|---|---|---|
| [`apps/desktop/src/runtime-closure.ts`](../apps/desktop/src/runtime-closure.ts)、[`apps/desktop/tests/runtime-closure.spec.ts`](../apps/desktop/tests/runtime-closure.spec.ts) | 新增模块与测试：打包、摘要、展开并自愈运行时归档 | 这就是交付形态；上游以散文件资源携带依赖树 |
| [`apps/desktop/src/main.ts`](../apps/desktop/src/main.ts) | 在后端启动前把归档展开到 `$DSH_HOME/closure/<版本>`，并上报进度 | 上游假定的运行时位置是 `resources/dsh`，本 fork 不再携带 |
| [`apps/desktop/src/paths.ts`](../apps/desktop/src/paths.ts) | 增加闭包根目录 | 展开目录属于 Electron 所有的路径 |
| [`apps/desktop/src/backend-controller.ts`](../apps/desktop/src/backend-controller.ts) | 在 `starting` 后端状态中携带展开进度 | 加载窗口需要渲染它 |
| [`apps/desktop/renderer/startup.html`](../apps/desktop/renderer/startup.html)、[`startup.js`](../apps/desktop/renderer/startup.js)、[`startup.css`](../apps/desktop/renderer/startup.css)、[`src/locale.ts`](../apps/desktop/src/locale.ts) | 确定进度条及其中英文案 | 首次启动要展开一万一千个文件；没有标签的转圈看起来像卡死 |
| [`apps/desktop/scripts/prepare-dsh.ts`](../apps/desktop/scripts/prepare-dsh.ts) | 打包已验证的依赖树，并证明归档能还原出它 | 当打包内容不是被验证的内容时，构建必须失败 |
| [`apps/desktop/scripts/desktop-build-paths.mjs`](../apps/desktop/scripts/desktop-build-paths.mjs)（含 [`.d.mts`](../apps/desktop/scripts/desktop-build-paths.d.mts)） | 增加归档与摘要路径 | 每个目标拥有自己的归档 |
| [`apps/desktop/electron-builder.config.mjs`](../apps/desktop/electron-builder.config.mjs)（含 [`.d.mts`](../apps/desktop/electron-builder.config.d.mts)） | 携带归档与摘要而非散文件树，在 `afterPack`/`afterSign` 校验，并以 `github` provider 发布 | 资源映射、构建期校验与发布目标都在此配置 |
| [`apps/desktop/scripts/desktop-auto-update-environment.mjs`](../apps/desktop/scripts/desktop-auto-update-environment.mjs)（含 [`.d.mts`](../apps/desktop/scripts/desktop-auto-update-environment.d.mts)） | 解析 GitHub 仓库、发布 tag 与发布类型，取代腾讯 COS origin 与 bucket | 本 fork 发布到自己的仓库 |
| [`apps/desktop/scripts/desktop-upload-plan.ts`](../apps/desktop/scripts/desktop-upload-plan.ts)、[`apps/desktop/scripts/upload-target.ts`](../apps/desktop/scripts/upload-target.ts) | 验证同样的产物并作为 GitHub release 资源上传 | 带校验的上传才是重点，只有传输方式改变 |
| [`apps/desktop/scripts/package-target.ts`](../apps/desktop/scripts/package-target.ts) | 记录 tag 与发布类型，并从打包子进程中移除 `GH_TOKEN`/`GITHUB_TOKEN` | 上传需要一条可信记录，而打包本身不需要凭据 |
| [`apps/desktop/scripts/desktop-release-environment.mjs`](../apps/desktop/scripts/desktop-release-environment.mjs)（含 [`.d.mts`](../apps/desktop/scripts/desktop-release-environment.d.mts)）、[`verify-macos-signature.mjs`](../apps/desktop/scripts/verify-macos-signature.mjs)、[`tests/macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts) | 接受完整证书通用名并据此推导短名 | 本机钥匙串中存在两个短名相同的证书，名称匹配因此有歧义 |
| [`apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`](../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs) | 移除 `fs-ext` 检查 | `@deepseek-ai/node-addon-system` 取代了该依赖，闭包中已无此文件 |
| [`apps/desktop/tests/main-startup.spec.ts`](../apps/desktop/tests/main-startup.spec.ts)、[`startup-renderer.spec.ts`](../apps/desktop/tests/startup-renderer.spec.ts)、[`macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts)、[`desktop-build-paths.spec.ts`](../apps/desktop/tests/desktop-build-paths.spec.ts)、[`desktop-auto-update-environment.spec.ts`](../apps/desktop/tests/desktop-auto-update-environment.spec.ts)、[`desktop-upload-plan.spec.ts`](../apps/desktop/tests/desktop-upload-plan.spec.ts)、[`package-target.spec.ts`](../apps/desktop/tests/package-target.spec.ts) | 跟随上述行为 | 测试描述的是本 fork 交付的行为 |
| [`packages/fs/tool-fs-search/src/search-core.ts`](../packages/fs/tool-fs-search/src/search-core.ts)、[`packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts`](../packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts)、[`patches/node-pty@1.2.0-beta.15.patch`](../patches/node-pty@1.2.0-beta.15.patch)、[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | 解包位于 `<name>.asar` 内的二进制路径，并让 node-pty 的加载器读取 `DSH_NODE_PTY_SPAWN_HELPER` | 两者都为已删除的壳解决同一问题：被启动的路径必须是真实文件。采用上游应用后运行时展开为真实目录，两个杠杆今天都不会触发；它们仍列在此处，因为它们仍是对上游文件的 fork 补丁 |

本子树需要的其他一切均为自己的文件：发布 workflow、Agent Note、历史发布文档，以及本文档。

让清单保持很短的规则是：fork 改动只在交付或发布身份需要时进入 `apps/desktop`，除非平台本身要求，绝不进入 harness 包。

## 休眠资产

| 路径 | 状态 | 保留原因 |
|---|---|---|
| [`packages/plugin-store`](packages/plugin-store)、[`packages/ui-plugin-store`](packages/ui-plugin-store) | 在工作区之外：既不构建也不运行 | 它们负责在运行中的应用内安装插件包。上游基于内置 pnpm 的插件管理窗目前覆盖该能力；这些包曾承载的 MCP 包面尚未在那里重新表达 |
| [`build/icons`](build/icons)、[`build/entitlements.mac.plist`](build/entitlements.mac.plist) | 当前打包未使用 | 上游配置使用 Electron 默认图标，因此启用这些图标属于需要单独验收的产品改动 |
| [`docs/releases`](docs/releases/README.zh.md) | 历史发布规划 | 记录每个版本当初的目标 |

## 标签与发布

一次发布以 `v<版本>` 打 tag，并由[发布 workflow](../.github/workflows/desktop-release.yml)发布为本仓库 `ceasarXuu/deepseek-harness-desktop` 中的 GitHub release。tag 就是版本本身，因为更新器的 GitHub provider 按语义版本比较 release tag，并从版本的预发布段推导预发布通道。`dsh-v*` 前缀属于上游发布列车，其标签会随每次上游拉取到来，因此不能共用。[发布目标决策](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.zh.md)负责说明更新源、凭据与上传校验。

## 预发布立场

本仓库的预发布立场在此完全适用：本 fork 没有外部消费者，因此优先选择正确的基础，而不是兼容垫片；磁盘格式可以改版，而不必迁移。这就是运行时归档对它首个写入的格式不提供迁移路径的原因。

## 本机工具链

运行任何 `pnpm run check:ci:*` 聚合，都要求 pnpm 是 JavaScript 入口，且其版本与 `package.json` 中 `packageManager` 锁定的版本一致。

这一要求源自 harness 的两处细节。`scripts/run-gates.ts` 会把每个门禁以 `node <npm_execpath> ...` 启动，只有当 `npm_execpath` 指向 JavaScript 文件时才可行。另外，若干包脚本会再次按名称调用 `pnpm`，而该嵌套进程会强制校验 `packageManager` 字段。

独立的 pnpm 二进制——即版本管理器（如 mise）安装的 `@pnpm/exe` 发行版——两条都不满足。它在第一条上表现为该聚合中每个门禁都报 `SyntaxError: Invalid or unexpected token`，在第二条上则报版本不匹配。由于报错指向的是单个门禁，从输出中不容易看出共同原因。

补救办法是在 `PATH` 中把锁定版本的 JavaScript 版 pnpm 排到该二进制之前，例如用一个 shim 执行 `node apps/desktop/node_modules/pnpm/bin/pnpm.cjs "$@"`。CI 天然满足这一点，因为 `pnpm/action-setup` 安装的正是 `package.json` 锁定的版本。

## 本地构建

三档成本，对应三类改动。

**直接从源码树运行。** 外壳与 harness 都运行工作区构建出的产物，因此界面工作完全不需要打包：

```sh
pnpm run dev:desktop
```

开发用 Harness 状态默认位于 `apps/desktop/.desktop-build/development/home`；[应用 README](../apps/desktop/README.zh.md)负责说明可覆盖项。

**安装一个开发版。** `--dir` 在组装出应用之后就停下，因此既不需要压缩安装包，也没有公证往返：

```sh
pnpm run package:desktop:mac:arm64:dir
ditto "apps/desktop/.desktop-build/targets/mac-arm64/artifacts/mac-arm64/DeepSeek Harness.app" "/Applications/DeepSeek Harness.app"
```

用它可以验证打包后的应用真实行为——首次启动展开、Resources 路径、崩溃处理——这些都不是源码树运行能复现的。但这里测不了更新：更新器读的是发布源，而 `--dir` 产物里没有可供更新的安装包。

**构建交付物。** 发布命令产出已签名并公证的 DMG 与 ZIP，上传步骤把它们发布出去：

```sh
pnpm run package:desktop:mac:arm64   # or package:desktop:mac:x64
GH_TOKEN=$(gh auth token) pnpm run upload:mac:arm64
```

每条打包命令都会执行正式构建、打包第一方生产依赖闭包、准备目标 Node.js 与 pnpm 运行时、物化并验证 dsh 依赖树、把它连同摘要打包为 `desktop-runtime.tar.zst`，并展开该归档以证明它能还原出依赖树。应用资源携带归档、其摘要，以及 Node.js 与 pnpm 运行时。

签名与公证环境、更新目标与上传凭据见[应用 README](../apps/desktop/README.zh.md)。

## 发布

| 版本 | 状态 | 目标 | 文档 |
|---|---|---|---|
| 0.0.1 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.zh.md) |
| 0.0.2 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.2`](docs/releases/v0.0.2/README.zh.md) |
| 0.0.4 | 提案中 | macOS（Apple Silicon、Intel） | [`docs/releases/v0.0.4`](docs/releases/v0.0.4/README.zh.md) |
