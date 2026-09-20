# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的桌面发行版：一个已签名、自包含的 macOS 应用，无需终端、无需系统 Node.js，也无需单独启动任何服务，即可运行 harness 及其浏览器界面。

应用本体来自上游——`apps/desktop`（Electron 壳）与 `apps/desktop-host`（私有 Host 进程），其组合方式、运行时布局、profile 处理、插件事务、恢复动作与更新单元均保持不变。本子树拥有的是发布从哪里来：本 fork 发布到哪个 GitHub release，以及用什么身份签名。[发布目标决策](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.zh.md)负责说明原因。

## 与 harness 的关系

外壳从应用携带的运行时启动私有 Host 进程，该进程挂载与 `dsh --profile web` 相同的插件树。有三条 harness 事实塑造了此处的全部设计决策，它们各自由声明它的包负责，而非本子树：

- 裸包名插件解析需要 Loader 访问内部模块（[`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)）。
- 默认持久化后端会立即导入 `node:zlib` 的 zstd，会话搜索索引则导入 `node:sqlite`（[`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.zh.md)）。
- 终端能力会立即加载 `node-pty` 原生 addon（[`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.zh.md)）。

## 开发模式

本仓库是 `deepseek-ai/deepseek-harness` 的长期 fork。开发在此进行；上游 `master` 只用于拉取更新。为桌面应用开发的内容一概不回贡上游。

这一安排让一个性质成为关键：**拉取上游的成本，与本 fork 改动多少上游文件成正比。** 每个被改动的上游文件都会在下次同步时变成合并冲突，因此桌面侧的工作优先新增文件，只在发布身份确实需要时才修改既有文件。当上游改动了交付方式或打包路径、使某处 fork 改动不再必要时，该改动会被丢弃，而不是继续携带。

### 本 fork 改动的上游文件

往这张表里加一行是一个决策，而不是副作用。上游自己的 [`apps/desktop/README.md`](../apps/desktop/README.zh.md) 记录了这些改动所取代的腾讯 COS 目标；打包各阶段本身未变。

| 文件 | 改动 | 为何无法避免 |
|---|---|---|
| [`apps/desktop/scripts/desktop-auto-update-environment.mjs`](../apps/desktop/scripts/desktop-auto-update-environment.mjs)（含 [`.d.mts`](../apps/desktop/scripts/desktop-auto-update-environment.d.mts)） | 解析 GitHub 仓库、发布 tag 与发布类型，取代腾讯 COS origin 与 bucket；从版本的预发布段推导频道元数据文件名 | 本 fork 发布到自己的仓库，且更新器的 GitHub provider 从版本推导频道 |
| [`apps/desktop/scripts/desktop-package-environment.mjs`](../apps/desktop/scripts/desktop-package-environment.mjs) | 接受 `DSH_DESKTOP_UPDATE_REPOSITORY` 作为发布设置 | test 部署需要声明它发布到哪个仓库 |
| [`apps/desktop/scripts/desktop-upload-plan.ts`](../apps/desktop/scripts/desktop-upload-plan.ts)、[`apps/desktop/scripts/upload-target.ts`](../apps/desktop/scripts/upload-target.ts) | 验证同样的完成记录、频道元数据、大小与摘要，再作为 GitHub release 资源上传；macOS lane 不上传频道元数据 | 带校验的上传才是重点，只有传输方式改变；且一次 release 只携带一份合并后的 macOS 频道文件 |
| [`apps/desktop/scripts/macos-app-update-config.mjs`](../apps/desktop/scripts/macos-app-update-config.mjs)（含 [`.d.mts`](../apps/desktop/scripts/macos-app-update-config.d.mts)） | 写出并校验 `github` provider 的 `app-update.yml`，取代固定的 generic feed | 打包后的应用从该文件读取它更新的仓库 |
| [`apps/desktop/scripts/electron-builder-config.mjs`](../apps/desktop/scripts/electron-builder-config.mjs) | 以 `github` provider 发布，并把 [`desktop/build/icons/icon-dark.icns`](build/icons) 指定为 macOS 图标 | 发布目标与本 fork 的应用图标在此配置 |
| [`apps/desktop/scripts/package-macos.ts`](../apps/desktop/scripts/package-macos.ts) | 校验各 lane 产物旁的频道文件，但不提升它 | 合并后的频道文件由 `finalize:mac:channel` 从 release 组装 |
| [`apps/desktop/scripts/package-target.ts`](../apps/desktop/scripts/package-target.ts) | 在完成记录中写入 tag 与发布类型，并从打包子进程中移除 `GH_TOKEN`/`GITHUB_TOKEN` | 上传需要一条可信记录，而打包本身不需要凭据 |
| [`apps/desktop/package.json`](../apps/desktop/package.json) | 增加 `finalize:mac:channel` 脚本 | 发布 workflow 会调用它 |
| [`apps/desktop/scripts/desktop-release-environment.mjs`](../apps/desktop/scripts/desktop-release-environment.mjs)（含 [`.d.mts`](../apps/desktop/scripts/desktop-release-environment.d.mts)）、[`verify-macos-signature.mjs`](../apps/desktop/scripts/verify-macos-signature.mjs) | 接受完整证书通用名并据此推导短名 | 本机钥匙串中存在两个短名相同的证书，名称匹配因此有歧义 |
| [`apps/desktop/tests/desktop-auto-update-environment.spec.ts`](../apps/desktop/tests/desktop-auto-update-environment.spec.ts)、[`desktop-upload-plan.spec.ts`](../apps/desktop/tests/desktop-upload-plan.spec.ts)、[`macos-app-update-config.spec.ts`](../apps/desktop/tests/macos-app-update-config.spec.ts)、[`macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts)、[`package-macos.spec.ts`](../apps/desktop/tests/package-macos.spec.ts)、[`package-target.spec.ts`](../apps/desktop/tests/package-target.spec.ts) | 跟随上述行为 | 测试描述的是本 fork 交付的行为 |

本子树需要的其他一切均为自己的文件：发布 workflow、Agent Note、历史发布文档，以及本文档。

## 休眠资产

| 路径 | 状态 | 保留原因 |
|---|---|---|
| [`build/entitlements.mac.plist`](build/entitlements.mac.plist)、[`build/icons`](build/icons) 中的浅色、透明与通用图标 | 未使用：打包配置只指定 `icon-dark.icns`，而上游配置不使用任何 entitlements 文件 | 本 fork 已删除的壳把其资产保留在此 |
| [`docs/releases`](docs/releases/README.zh.md) | 历史发布规划 | 记录每个版本当初的目标 |

## 标签与发布

一次发布以 `v<版本>` 打 tag，并由[发布 workflow](../.github/workflows/desktop-release.yml)发布为本仓库 `ceasarXuu/deepseek-harness-desktop` 中的 GitHub release。tag 就是版本本身，因为更新器的 GitHub provider 按语义版本比较 release tag，并从版本的预发布段推导预发布通道，因此 `0.1.6-alpha.2` 在 tag `v0.1.6-alpha.2` 下发布 `alpha-mac.yml`，稳定版本则发布 `latest-mac.yml`。`dsh-v*` 前缀属于上游发布列车，其标签会随每次上游拉取到来，因此不能共用。[发布目标决策](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.zh.md)负责说明更新源、凭据与上传校验。

## 预发布立场

本仓库的预发布立场在此完全适用：本 fork 没有外部消费者，因此优先选择正确的基础，而不是兼容垫片；磁盘格式可以改版，而不必迁移。

## 本机工具链

运行任何 `pnpm run check:ci:*` 聚合，都要求 pnpm 是 JavaScript 入口，且其版本与 `package.json` 中 `packageManager` 锁定的版本一致。

这一要求源自 harness 的两处细节。`scripts/run-gates.ts` 会把每个门禁以 `node <npm_execpath> ...` 启动，只有当 `npm_execpath` 指向 JavaScript 文件时才可行。另外，若干包脚本会再次按名称调用 `pnpm`，而该嵌套进程会强制校验 `packageManager` 字段。

独立的 pnpm 二进制——即版本管理器（如 mise）安装的 `@pnpm/exe` 发行版——两条都不满足。它在第一条上表现为该聚合中每个门禁都报 `SyntaxError: Invalid or unexpected token`，在第二条上则报版本不匹配。由于报错指向的是单个门禁，从输出中不容易看出共同原因。

补救办法是在 `PATH` 中把锁定版本的 JavaScript 版 pnpm 排到该二进制之前，例如用一个 shim 执行 `node apps/desktop/node_modules/pnpm/bin/pnpm.cjs "$@"`。CI 天然满足这一点，因为 `pnpm/action-setup` 安装的正是 `package.json` 锁定的版本。

## 本地构建

两档成本，对应两类改动。

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

用它可以验证打包后的应用真实行为——Resources 路径、自带运行时、崩溃处理——这些都不是源码树运行能复现的。但这里测不了更新：更新器读的是发布源，而 `--dir` 产物里没有可供更新的安装包。

**构建交付物。** 每条打包命令都要求签名与公证凭据，它们以 secret 形式保存在 CI，因此发布由 workflow 构建，而不是在工作站上：

```sh
pnpm run package:desktop:mac:arm64   # or package:desktop:mac:x64
GH_TOKEN=$(gh auth token) pnpm run upload:mac:arm64
```

一次打包命令会准备目标运行时、物化并验证 dsh 依赖树、构建应用，并产出 DMG、ZIP 及其 blockmap 与该版本的频道元数据。打包读取 `apps/desktop/.env.macos`，其发布设置从不回退到 shell 环境；[其模板](../apps/desktop/.env.macos.example)列出所有可接受的设置。签名与公证会完成该请求所需的 Apple 侧检查。

发布 workflow 用其 secret 写出该文件，打包两个 macOS 目标，对刚产出的产物校验签名、Gatekeeper 与已装订的票据，上传二进制，并最后发布合并后的频道文件。Windows 发布仍然不可及：签名需要挂在自托管 runner 上的 SafeNet token，因此该 lane 只把未签名安装器作为 workflow 产物，不触碰任何 release。

## 发布

| 版本 | 状态 | 目标 | 文档 |
|---|---|---|---|
| 0.0.1 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.zh.md) |
| 0.0.2 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.2`](docs/releases/v0.0.2/README.zh.md) |
| 0.0.4 | 提案中 | macOS（Apple Silicon、Intel） | [`docs/releases/v0.0.4`](docs/releases/v0.0.4/README.zh.md) |
