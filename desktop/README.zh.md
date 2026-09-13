# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的桌面发行版：一个已签名、自包含的 macOS 应用，无需终端、无需系统 Node.js，也无需单独启动任何服务，即可运行 harness 及其浏览器界面。

harness 本身位于 [`packages/`](../packages/README.md) 与 [`apps/cli`](../apps/cli/README.md)，本子树不改动它。`desktop/` 只负责打包层与应用层，把组合好的 harness 变成可安装的应用。

## 目录结构

| 路径 | 职责 |
|---|---|
| [`docs/releases/`](docs/releases/README.md) | 按版本规划：某个已发布桌面版本的范围、架构、打包、分发与风险 |
| `apps/shell/` | Electron 应用：主进程、preload、窗口生命周期、harness 监管、原生对话框、更新器 |
| `packages/bundle-desktop-app/` | 组合启动的 Cordis 组合包：`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之上的补丁层、桌面运行时粘合层，以及打包入口 |
| `runtime-closure/` | 纯依赖的部署根目录，其闭包即打包应用实际交付的内容。与 `python/sdk-runtime` 一样，仅为依赖解析而加入工作区 |
| `build/` | 闭包构建脚本、entitlements、图标源文件与生成的 `.icns` |

## 与 harness 的关系

桌面应用是一种组合，而非 fork。它通过 [`packages/boot/app-boot`](../packages/boot/app-boot/README.md) 中同一个 `boot()` 入口，启动与 `dsh --profile web` 相同的插件树，区别只在于使用冻结的依赖闭包，而不是 profile 目录。

有三条 harness 约定塑造了此处的全部设计决策，它们各自由所属包负责，而非本子树：

- 裸包名插件解析需要 Loader 访问内部模块（[`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)）。
- 默认持久化后端会立即导入 `node:zlib` 的 zstd，会话搜索索引则导入 `node:sqlite`（[`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.md)）。
- 终端能力会立即加载 `node-pty` 原生 addon（[`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.md)）。

## 开发模式

本仓库是 `deepseek-ai/deepseek-harness` 的长期 fork。开发在此进行；上游 `master` 只用于拉取更新。为桌面应用开发的内容一概不回贡上游。

这一安排让一个性质成为关键：**拉取上游的成本，与本子树改动多少上游文件成正比。** 每个被改动的上游文件都会在下次同步时变成合并冲突，因此桌面侧的工作优先新增文件，只在组合确实需要时才修改既有文件。

### 本子树改动的上游文件

这份清单刻意保持很短，每一条都是追加式列表插入，不改变上游行为。往这张表里加一行是一个决策，而不是副作用。

| 文件 | 改动 | 为何无法避免 |
|---|---|---|
| [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | 在 `packages` 中加入 `desktop/*` 与 `desktop/apps/*` | workspace 成员资格是应用与新包可解析、并被依赖检查覆盖的前提 |
| [`tsdown.config.ts`](../tsdown.config.ts) | 在 `workspace` 中加入 `desktop/packages/*/*` | 构建按显式 workspace glob 逐包进行，不在其中的包永远不会被构建，也不会进入闭包 |
| [`tsconfig.base.json`](../tsconfig.base.json) | 在既有 `@deepseek-ai/dsh-*` 路径数组中追加 `./desktop/packages/*/src` 与 `./desktop/apps/*/src` | 路径映射决定 workspace 导入解析到源码而非构建产物，而它的数组是显式目录列表 |
| [`tsconfig.host.json`](../tsconfig.host.json) | 增加覆盖桌面包源码与测试的 glob，并为每个 desktop 宿主包增加一条 project reference | 该编译面的 `include` 决定为为宿主侧做类型检查的程序，而桌面包无法从列表中任何已有条目经导入到达 |
| [`tsconfig.client.json`](../tsconfig.client.json) | 增加指向 desktop 浏览器界面的 project reference | 客户端聚合通过显式 references 编译浏览器包，而插件面板正是其中之一 |
| [`vitest.config.ts`](../vitest.config.ts) | 在 `testIncludes` 中加入 `desktop/packages/*/tests/**/*.spec.ts` | 运行器的 include 列表是显式的；不加则子树里的测试存在但从不运行 |

桌面应用需要的其他一切均为新文件：应用、组合包、闭包 manifest、构建配置、发布工作流、Agent Note，以及本文档。

让这份清单保持很短的规则是：桌面包不得原地修改 harness 包。当组合需要不同行为时——目录选择器就是当前一例——桌面子树在同一条能力 seam 上提供自己的实现，并让既有提供方保持不动。

还有一种可选布局：把新包放进既有的 `packages/<group>/` 目录，能被上述四个 glob 中的三个匹配，清单就只剩一个文件。之所以不选它，是因为独立子树能明确说明本 fork 新增了哪些包，并让它们不出现在上游的包清单中，而四处列表插入比这点歧义更便宜。

### 标签与发布

桌面版发布使用 `desktop-v*` 标签前缀。`dsh-v*` 前缀属于上游发布列车，该列的标签会随上游拉取一并到来，共用前缀最终会撞车。

### 预发布立场

本仓库的预发布立场在此完全适用：本 fork 没有外部消费者，因此优先选择正确的基础，而不是兼容垫片；磁盘格式可以改版，而不必迁移。这就是桌面设计对它首个写入的格式不提供迁移路径的原因。

### 本机工具链

运行任何 `pnpm run check:ci:*` 聚合，都要求 pnpm 是 JavaScript 入口，且其版本与 `package.json` 中 `packageManager` 锁定的版本一致。

这一要求源自 harness 的两处细节。`scripts/run-gates.ts` 会把每个门禁以 `node <npm_execpath> ...` 启动，只有当 `npm_execpath` 指向 JavaScript 文件时才可行。另外，若干包脚本会再次按名称调用 `pnpm`，而该嵌套进程会强制校验 `packageManager` 字段。

独立的 pnpm 二进制——即版本管理器（如 mise）安装的 `@pnpm/exe` 发行版——两条都不满足。它在第一条上表现为该聚合中每个门禁都报 `SyntaxError: Invalid or unexpected token`，在第二条上则报版本不匹配。由于报错指向的是单个门禁，从输出中不容易看出共同原因。

补救办法是在 `PATH` 中把锁定版本的 JavaScript 版 pnpm 排到该二进制之前。CI 天然满足这一点，因为 `pnpm/action-setup` 安装的正是 `package.json` 锁定的版本。

### 本地构建

三档成本，对应三类改动。

**直接从源码树运行。** 外壳从 `DSH_DESKTOP_CLOSURE` 读取运行时位置，因此改动外壳或桌面组合包完全不需要打包。该值就是存放 `harness.asar` 的目录，即打包应用 `Resources` 里的内容：

```sh
pnpm --filter @deepseek-ai/dsh-desktop-app run build
pnpm --filter @deepseek-ai/dsh-desktop-shell run build
DSH_DESKTOP_CLOSURE="$PWD/desktop/build/out" \
  ./desktop/apps/shell/node_modules/.bin/electron desktop/apps/shell
```

这是界面工作与 harness 行为的主力循环。它跑的是与打包应用同一个子进程、同一条就绪记录、同一个窗口，且完全跳过签名。

**安装一个开发版。** `--dir` 在组装出应用之后就停下，因此既不需要压缩安装包，也没有公证往返：

```sh
node desktop/build/package-app.mjs --dir
ditto "desktop/apps/shell/dist/mac-arm64/DeepSeek Harness.app" "/Applications/DeepSeek Harness.app"
```

用它可以验证打包后的应用真实行为 —— Resources 路径、登录 shell 的 `PATH` 解析、崩溃处理 —— 这些都不是源码树运行能复现的。但这里测不了更新：更新器读的是发布源，而 `--dir` 产物里没有可供更新的安装包。

**构建交付物。** `node desktop/build/package-app.mjs` 产出 DMG 与 ZIP，并使用钥匙串中的身份签名。加上 `DSH_DESKTOP_NOTARIZE=1` 并在环境中提供公证凭据，产出的就是发布所用的东西。

三者都复用已有的闭包，因为闭包是最慢的一步、也是变化最少的一步。因此一旦构建过一次，就相当于隐含了 `--skip-closure`；改动 harness 包后要强制重建，删除 `desktop/build/out/harness.asar` 即可。

## 发布

| 版本 | 状态 | 目标 | 文档 |
|---|---|---|---|
| 0.0.1 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.md) |
| 0.0.2 | 提案中 | macOS（Apple Silicon） | [`docs/releases/v0.0.2`](docs/releases/v0.0.2/README.md) |
