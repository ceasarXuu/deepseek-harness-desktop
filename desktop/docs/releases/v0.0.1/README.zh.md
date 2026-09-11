# 桌面版 v0.0.1

[English](README.md) | 中文

状态：提案中

DeepSeek Harness 的首个桌面版本：一个以已签名并公证的 DMG 交付的 macOS 应用，用户把它拖入「应用程序」文件夹即可安装，双击即可运行，无需终端、无需系统 Node.js、无需包管理器，也无需单独启动服务。

## 本版本必须达成什么

从未打开过终端的最终用户，可以从下载的 DMG 出发，得到一个可用的编程智能体，并且能在应用内收到后续的官方版本。

具体来说，安装并启动应用之后：

- harness 启动并提供其界面，用户除应用本身外无需安装或配置任何东西。
- 用户通过 macOS 原生对话框选择 workspace 文件夹，无需输入任何路径。
- 用户在应用自身的界面中输入 API 凭据，该凭据在多次启动之间持续有效。
- 会话、工具、批准、plan 与斜杠命令的行为与已发布的浏览器界面一致。
- agent 能在选定的 workspace 中执行 shell 命令，而无需用户打开终端。
- 应用内可检测、下载并应用后续的官方版本，应用随即重启进入该版本。

## 本版本不包含什么

| 不包含 | 原因，以及在何处重新考虑 |
|---|---|
| Windows 与 Linux 构建 | 本版本只针对一个平台，以缩小签名、依赖与验证面。跨平台打包推迟到下一个版本。 |
| Intel Mac 支持 | 首个版本只支持 Apple Silicon。通用打包会让原生产物的验证面翻倍。 |
| 以 IPC 传输取代回环 HTTP 服务器 | 本版本中 harness 保留其已交付的传输方式。自定义协议与 IPC 载体路径在 [`architecture.md`](architecture.md) 中描述为后续改动。 |
| 终端或 TUI 前端 | 浏览器界面即产品界面。harness 不交付任何终端 UI 包。 |
| 应用内插件安装或插件市场 | 打包的闭包在构建时即冻结。已交付的界面只提供只读的插件清单。 |
| 内置模型或离线模式 | agent 通过网络访问 DeepSeek API。不包含任何本地推理。 |
| 稳定版之外的自动更新通道 | 只发布并消费一个更新源。 |

## 改动范围

本版本新增一个子树，以及少量 harness 侧的增补。它不修改 agent loop、会话格式或任何能力 seam。

| 区域 | 改动 | 归属 |
|---|---|---|
| Electron shell | 新增 | `desktop/apps/shell` |
| 基于 `dsh-base` 的桌面组合包 | 新增 | `desktop/packages/bundle-desktop-app` |
| 打包的运行时闭包 | 新增 | `desktop/packages/runtime-closure` |
| 构建、签名、公证、DMG | 新增 | `desktop/build` |
| workspace 定义 | 在 [`pnpm-workspace.yaml`](../../../../pnpm-workspace.yaml) 中加入 `desktop/*` | 根目录 |
| 打包宿主中的原生目录选择器 | 仅本组合替换为 Electron 支持的提供方；既有提供方包保持不变 | 桌面组合包 |
| 到达界面的宿主诊断 | 新增：捕获的运行时输出与已渲染的 agent 错误界面 | 桌面组合包与应用 |

## 如何判定完成

每一项都无需阅读实现即可核查。

1. 由打标签的提交构建出的 DMG，能安装在一台从未有过 Node.js、pnpm 或本仓库的 macOS 机器上。
2. `spctl --assess --type execute` 接受已安装的应用，且 `codesign --verify --deep --strict` 通过。
3. 启动应用后在 [`plan.md`](plan.md) 记录的启动预算内呈现界面，且没有任何需要终端的窗口。
4. 引导流程通过界面接受 API 凭据，并完成第一个轮次。
5. agent 在选定的 workspace 中执行 shell 命令，结果渲染为工具卡片。
6. 退出应用会终止 harness 进程，不留下孤儿进程，也不留下占用的端口。
7. 发布更高版本后，正在运行的应用会提示该版本，接受后重启进入新版本，且 workspace 与会话历史保持完好。
8. 签名、公证与打包步骤在 CI 中对打标签的提交无人值守地运行。

## 文档

| 文档 | 内容 |
|---|---|
| [`architecture.md`](architecture.md) | 进程模型、运行时载体决策、启动序列、组合与磁盘位置 |
| [`packaging.md`](packaging.md) | 应用包布局、原生产物、`asar` 规则、签名、公证、DMG |
| [`distribution.md`](distribution.md) | 版本号、发布流水线、更新源与更新行为 |
| [`experience.md`](experience.md) | 首次运行、workspace 与凭据处理、生命周期，以及为不使用终端的用户提供的诊断 |
| [`plan.md`](plan.md) | 阶段、Phase 0 验证性实现与退出标准 |
| [`risks.md`](risks.md) | 风险登记表、回退方案与开放问题 |
