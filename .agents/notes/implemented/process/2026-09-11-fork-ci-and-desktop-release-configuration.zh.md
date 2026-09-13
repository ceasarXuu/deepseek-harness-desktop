# Agent Note: fork CI 与桌面版发布配置

Status: implemented

[English](2026-09-11-fork-ci-and-desktop-release-configuration.md) | 中文

## Problem

本仓库是 `deepseek-ai/deepseek-harness` 的长期 fork：它接受上游更新，不回贡任何内容。继承而来的持续集成安排假定的是上游账号。

上游的 `ci.yml` 把必需任务调度到组织专属的 runner 池（`dsh-ubuntu-24-04-16core`、`dsh-windows-2025-16core`）以及自托管标签（`[self-hosted, linux, x64, vm-backup]`、`[self-hosted, dsh-win-ci, windows]`）。本账号下这些都不存在，因此一次运行会一直排队直到超时，而不是给出结论；而超时的任务在到期之前与一个缓慢的任务无法区分。另外若干继承的 workflow 要么需要本 fork 不持有的凭据，要么会发布到它并不拥有的注册表与站点。

因此在本 fork 上没有任何可用信号，而桌面发行版即将开始向 harness 组合提交改动。

第二个问题属于本机而非仓库整体。每个 `check:ci:*` 聚合都会立即失败，产生 35 个失败，而其共同原因不可见：`scripts/run-gates.ts` 把每个门禁以 `node <npm_execpath> ...` 启动，而版本管理器安装的 `@pnpm/exe` 发行版把 `npm_execpath` 指向一个原生二进制。另外，按名称调用 `pnpm` 的包脚本会解析到与 `packageManager` 字段不一致的版本并拒绝运行。

## Decision

### 本 fork 拥有自己的检查

`.github/workflows/fork-ci.yml` 承载本 fork 的信号，且只使用标准 GitHub 托管 runner——对公开仓库而言它们没有分钟配额。共四个任务：静态门禁聚合、单元测试、无密钥快照回放，以及在 macOS 上运行类型检查与测试的通道。

macOS 通道之所以存在，是因为桌面发行版的目标平台是 macOS，并且依赖 Linux 运行无法覆盖的平台特有行为：`node-pty` addon、Seatbelt 沙箱档位，以及持久终端后端所执行的进程检查。

### 继承的 workflow 通过设置禁用，而不是靠编辑

上游 workflow 文件保持与上游逐字节一致，并通过仓库设置禁用。编辑它们会让本 fork 的分叉集合多出七个文件，并且在每次上游拉取时都要重新解决冲突；而设置不会被拉取携带，也无需维护。

无论如何，它们的发布步骤都无法从这里触发，因为每一步都是受 environment 与标签校验保护的手动 dispatch。真正会运行起来的自动步骤只是无凭据的打包。因此禁用针对的是 runner 时间，以及上游 `ci.yml` 产生误导性的排队运行，而不是阻止发布。

GitHub 只有在首次向本 fork push 之后才会注册 workflow 文件。因此禁用是那次 push 之后的步骤，而不是之前的。

各项处置记录在 [`desktop/docs/releases/v0.0.1/distribution.md`](../../../../desktop/docs/releases/v0.0.1/distribution.md)：会失败或浪费 runner 时间的 workflow 被禁用，而已经使用标准 runner 且仍能给出有用信号的则保留。

### 发布 environment 先于发布 workflow 创建

`desktop-release` environment 把部署限定为匹配 `desktop-v*` 的标签，并要求部署推进前有审批人。在消费它的 workflow 之前创建它，意味着首次发布无法在未经批准的情况下完成，而不是等有人想起来才加上保护。

### pnpm 必须是 JavaScript 入口

这一要求写在 [`desktop/README.md`](../../../../desktop/README.md) 中，而不是在 `scripts/run-gates.ts` 里绕过。该脚本的 `node <npm_execpath>` 调用对 CI 安装的 pnpm 发行版而言是正确的，原生二进制发行版才是异常：它无法被 `node` 执行，也不是本仓库锁定的版本。为迁就它而弱化该调用，会把一个真实的配置错误藏在一个回退之后。

## 本 fork 首次运行暴露出的条件

在标准托管 runner 而非上游池上运行继承来的门禁，暴露出四项上游安排不会触及的条件。之所以记录它们，是因为它们是 harness 或标准 runner 镜像的性质，而不是本 fork 配置的产物。

**归档基线必须是"未设置"而不是"空"。** [`scripts/verify-archived-agent-notes.ts`](../../../../scripts/verify-archived-agent-notes.ts) 以 `process.env.DSH_ARCHIVE_BASE_REF ?? 'HEAD'` 解析基线，因此未设置时回退到 `HEAD`，而空字符串会被原样使用并导致 `git rev-parse` 失败。上游 pull-request 任务中的表达式在其他任何事件下都会解析为空字符串；由于该任务只在 pull request 上运行，这在上游无害。本 fork 的 workflow 也在 push 上运行，因此它在一个步骤里解析基线，并在事件不携带可用提交时让该变量保持未设置。

**标准 Ubuntu 镜像自带 PowerShell。** `pwsh-tool-turn` 场景的跳过守卫探测 `pwsh` 可执行文件能否运行，而挂载 pwsh 工具的组合是按 win32 门控的。在一个拥有该二进制的 Linux 主机上，守卫会放行一个其组合永远无法挂载该工具的场景，请求头随即发生偏离。上游的 Linux 池不携带 pwsh，因此这一错配在那里不可见。本 fork 的快照任务移除预装的二进制，从而恢复该守卫所针对的条件。

**该场景中还有一个措辞陈旧的夹具。** 它的 `job_kill` 原因描述写的是 `forwarded to the task`，而源码与其余所有夹具写的是 `job`。该场景无法在任何未挂载 pwsh 工具的主机上运行，这正是该陈旧之处未被发现的原因。守卫与夹具在此都未修正：两者都归上游所有，而本 fork 的分叉预算只覆盖 [`desktop/README.md`](../../../../desktop/README.md) 中记录的那些追加式列表插入。

**回放场景需要 bubblewrap。** 沙箱的 Linux 链路先解析 bubblewrap 再解析 Landlock，而标准托管镜像既不提供该二进制，也不提供不受限的非特权用户命名空间。[`scripts/prepare-ci-bubblewrap.sh`](../../../../scripts/prepare-ci-bubblewrap.sh) 两者都提供；上游的 consumer 通道会运行它，本 fork 的快照任务现在也会。

**单元测试套件需要为它自己派生的进程留出 CPU。** `packages/subprocess/subprocess-local/tests/process-exit.spec.ts` 通过 tsx 启动其场景宿主，并等待子进程发布就绪文件，而三十秒的上限从子进程启动时就开始计时。vitest 的默认值是每个 CPU 一个 fork worker，而该配置有两个 project，因此在四核 runner 上会运行八个 worker，再加上这些测试派生的子进程；终端场景因此撞上上限，而不是测量它在隔离状态下的 332 毫秒。本 fork 的单元测试任务限制了 worker 池，因为替代方案是让一个门禁为调度产物报告真实失败。

**pnpm 不会剥离 `--` 分隔符。** `pnpm run test -- --maxWorkers=2` 到达 vitest 时是 `vitest run -- --maxWorkers=2`，该分隔符把选项变成了位置性的文件名过滤条件，于是选项被静默地忽略。可行的写法是 `pnpm run test --maxWorkers=2`。这一点值得写明，因为带分隔符的写法是最常被写出的那种，而它的失败是静默的：选项被当作过滤条件消费掉，运行只是使用了默认值。

## Alternatives considered

**就地编辑上游 workflow 以改runner。** 否决：它把七个上游拥有的文件变成每次拉取都要处理的合并冲突，只为获得一个单独 workflow 文件就能提供、且不必触碰它们的信号。

**删除上游 workflow。** 否决：删除同样是一种分叉，而且会丢失未来拉取本会重新加回的文件内容。设置是可逆的，并让工作树持续跟随上游。

**保留上游 workflow 并忽略失败。** 否决，因为一个排队后超时的必需任务比没有任务更糟：它消耗 runner 分配，并产生一个读起来像真实失败、却不携带任何信息的结论。

**把本 fork 的任务改到自托管 runner。** 否决：本账号没有这样的 runner，桌面侧工作也不需要它们。标准 runner 在两分钟内即可跑完静态聚合。

**弱化 `run-gates.ts` 以容忍原生 pnpm。** 否决，理由同上：该调用编码了一条真实要求，异常是本机工具链的选择，而不是仓库约束。

**修正 `pwsh` 场景的守卫及其陈旧夹具。** 否决：两个文件都归上游所有，任一编辑都会在每次拉取时变成合并冲突。该守卫的缺陷是真实的——它检测的是二进制，而组合检测的是平台——本 fork 记录它而不修复它，因为修复它不会带来本 fork 需要的任何信号。上游贡献才是该修复的归宿，而本 fork 不做贡献。

**在本 fork 上跳过快照通道。** 否决：它的十九个文件中十七个通过，且覆盖桌面发行版所启动的成型组合。移除该通道所需的环境条件，等于为了回避两处已知且有解释的偏离而丢弃这些覆盖。

## Consequences

**所得**：一个给出结论而不是超时的 fork 信号；一条覆盖桌面发行版目标平台的 macOS 通道；一条首次发布即需批准的发布路径；以及一个失败模式的原因记录，而该模式的 35 个症状指向的是单个门禁而非工具链。

**所付**：七个上游 workflow 文件以禁用状态留在工作树中，而这一状态从源码不可见，因此仅读 `.github/workflows/` 的读者无法判断哪些会运行。发布文档中的处置表是唯一记录。现在往本仓库新增 workflow，需要在 fork 边界的两侧都决定其处置。

**尚未解决**：公证凭据尚未配置，因此本机构建出的 DMG 已签名但不携带公证票据。[`desktop/docs/releases/v0.0.1/packaging.md`](../../../../desktop/docs/releases/v0.0.1/packaging.md) 把这一区别记录为发布前置条件，而不是构建步骤。
