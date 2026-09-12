# Agent Note: 桌面应用组合与外壳

Status: implemented

[English](2026-09-12-desktop-application-composition.md) | 中文

## Problem

桌面发行版需要让 harness 运行在一个打包好的应用里，而目标机器上没有 Node.js、没有包管理器、也没有终端。而 harness 当前的形态假定的是反面：[`apps/cli`](../../../../apps/cli/README.md) 从 harness home 下的 profile 目录解析组合包、通过 Node 的模块解析按裸名挂载插件，并且——如 [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md) 所记录——安装一个会终止所在进程的处理器，并强制挂载一个 HMR 服务，这两者都属于交互式终端应用。

把 harness 直接跑在 Electron 主进程里同样不可行。终端能力会立即导入 `node-pty`，裸包名解析需要 Node 的内部 ESM loader，而启动器的故障处理会在一次未处理的 rejection 上终止整个应用。

## Decision

### harness 是一个从冻结闭包启动的子进程

外壳把本进程以 Node 身份重新进入（`ELECTRON_RUN_AS_NODE=1`）并带上 `--expose-internals`，运行 `<closure>/node_modules/@deepseek-ai/dsh-desktop-app/lib/entry.js`。一个二进制、一份签名，bundle 里没有第二个运行时。

入口调用 `boot()` 而不是 `runProfile()`。这正是让 profile 目录彻底不出现的原因：不创建任何 `$DSH_HOME/profiles`、不运行任何包管理器，组合就是闭包所交付的内容。

### 桌面组合叠加在浏览器组合之上

桌面组合包依次组合 `dsh-base`、`dsh-web-app`，再叠加自己的补丁。与浏览器部署相比只有三行不同，因此浏览器 roster、传输层和 agent preset 平面原样到达，而不必重述：

| 行 | 桌面取值 | 原因 |
|---|---|---|
| `webserver` | 回环地址、端口 `0` | 每个窗口一个 harness；固定端口会让第二个实例变成绑定失败 |
| `web-runtime` | `printUrl: false`、`surfaceContext: false` | URL 行是给人看的就绪信号，而 web-surface 提示词是为「在被服务的应用上工作的 agent」准备的 |
| `client-hmr` | 禁用 | 打包后的闭包不可变，重载监视器没有可观察的对象 |

桌面运行时粘合层做了一件浏览器粘合层不做的事：在 Loader 结算之后向 stdout 写一条结构化的就绪记录，外壳据此得知绑定的端口。

**就绪约定。** 一行 `dsh-desktop-ready {"port":N,"url":"...","version":"..."}`。监管者解析它，而不是解析浏览器那句散文式 URL 行；它只在 Loader 结算之后发出，因此窗口打开时不会有兄弟行仍在挂载。

### 闭包由可验证的脚本构建

[`desktop/build/build-closure.mjs`](../../../../desktop/build/build-closure.mjs) 执行部署，然后修补并验证结果。实测表明裸 `pnpm deploy` 产出的闭包无法启动：`link:` overrides 让 vendor 框架包完全缺失、符号链接指回本仓库，并且有四个已声明的工作区依赖被静默漏掉。

因此该脚本会补回部署未放置的任何已声明依赖、把每个符号链接替换为真实副本，并在已声明依赖缺失或仍有符号链接残留时大声失败。闭包是应用实际承载的内容，所以要检验而不是信任。

## Alternatives considered

**把 harness 跑在 Electron 主进程里。** 否决，理由即 Problem 中的三条：立即加载的原生 addon、对 Loader 内部模块的要求，以及启动器的进程终止处理器。它还会让 harness 的崩溃把整个应用一起带走。

**改用 SDK 运行时那个 `pkg --sea` 单文件可执行产物。** 作为首选载体否决：它在 harness 与其自身包树之间加了一层虚拟文件系统，从而把客户端 bundle 读取、`createRequire` 解析和 worker 入口路径都置于归档语义之后。若闭包方案失败，它仍是 [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md) 中记录的备选。

**在桌面组合包里重述浏览器 roster。** 否决：桌面界面就是同一个浏览器界面，第二份五十行的副本只会与第一份漂移，而不表达任何差异。

**由外壳打印就绪记录。** 否决：只有 harness 自己知道它的树何时结算完毕，靠轮询猜测就绪的外壳会在组合只挂载了一半时就打开窗口。

## Consequences

**所得**：一个 harness 从应用自带闭包启动的桌面应用，无需安装 Node、无需 profile 目录、无需包管理器；一个与浏览器部署仅三行不同的组合；以及一个在闭包不完整时直接失败、而不是把启动错误抛给用户的闭包构建。

**所付**：闭包在压缩前约占 355 MB 磁盘空间，因为它承载组合可能挂载的每一个包。就绪记录是外壳与 harness 之间的新协议，因此两端必须一起变更。

**尚未验证**：打包产物本身。外壳与闭包是从源码树验证的；签名、公证与 DMG 属于 Stage 3。
