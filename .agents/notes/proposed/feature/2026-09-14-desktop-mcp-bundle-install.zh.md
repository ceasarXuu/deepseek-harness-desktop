# Agent Note: 在采用后的 Desktop 应用中安装 MCP 包

Status: proposed

[English](2026-09-14-desktop-mcp-bundle-install.md) | 中文

本改动作用于[采用的上游应用](../../implemented/architecture/2026-09-13-adopt-upstream-desktop.zh.md)；包的 server 运行在[运行时归档](../../implemented/architecture/2026-09-13-desktop-runtime-archive.zh.md)之上。

## 问题

采用后的应用能安装 npm 插件，却不能安装 MCP server 包。本 fork 自己的实现——`desktop/packages/plugin-store` 与 `desktop/packages/ui-plugin-store`——处于休眠，因为它用到的每个面都不复存在：它们通过 `ctx.webServer` 注册 REST 路由，而桌面组合关闭了该行；Web 面板读取 `globalThis.dshShell.pickPluginBundle`，那是已删除的自研壳暴露的桥，而采用后的壳暴露的是 `dshDesktop`。

它们承载的是能力本身：从文件或 URL 安装一个 `.mcpb` 包（内含 `manifest.json`、server 及其 `node_modules` 的 zip），用应用自身的二进制以 Node 方式重新进入来运行其 server，并把工具以 `mcp__<server>__<tool>` 暴露出来，用户无需安装 Node 或包管理器。`@deepseek-ai/dsh-mcp-client` 已在随包运行时中并链接进 profile，因此宿主侧已经具备；缺的只是安装与挂载。

## 提案

把 MCP 包变成**生成式的桌面插件**，从而由采用后应用自身的插件机制完成安装、校验、挂载与移除。

- **安装**把归档解到 `$DSH_HOME/plugins/<id>/<版本>/`，并在 profile 中就地生成插件：`node_modules/<生成名>/package.json` 声明对共享宿主包的 `peerDependencies`，其 `dsh.bundle.patch` 依据 manifest 的 `mcp_config` 挂载 `@deepseek-ai/dsh-mcp-client`，包内携带自身文件。profile manifest 以 `file:./plugins/<id>` 记录它——这是本方案唯一需要的放宽：`projectManifest` 目前只接受精确 registry 版本。
- **挂载**走应用现有事务：插件窗停后端、改 profile、起后端，组合随即将该行挂载。没有实时挂载、没有新的宿主协议、没有新的宿主包——挂载路径与任何已安装插件完全相同。
- **运行**保留本 fork 的运行时规则：manifest 里的 `command: "node"` 是意图，因此 patch 指定应用自身的 Node 并以 `ELECTRON_RUN_AS_NODE` 重新进入；宿主无法运行的 `server.type`（`python`、`uv`）在安装时即被拒绝并给出原因。
- **移除**删除生成的插件、清掉 profile 条目、清理该包的各个版本，后端重启后其工具随之卸载。禁用保留文件，与插件禁用一致。

插件窗新增第二区块：列出已安装包及其状态与工具，提供安装表单（通过新的桥方法选择文件，另加 URL 输入）与启用/禁用、移除操作，全部经由与上方插件区块同类的具名 IPC 通道。所有文案都加入两套词典，并在安装前说明包是外部程序。

## 考虑过的替代方案

- **把 `plugin-store` 移植到 `/api/*` 路由，并在 Web 设置区重新安装 `ui-plugin-store`。** 否决：桌面宿主把 `/api/*` 渲染为 Typert RPC 面加上显式注册的 fetch 路由，因此这意味一个宿主侧服务、一个从 `/plugins/…` 提供的客户端包，以及一个要通过 profile 校验的实时挂载——三处新面，换一个生成目录加一处校验放宽。
- **新增宿主侧包，并由 desktop patch 层挂载它。** 这正是"包即插件"方案不采用的设计：手写进 profile 的包处于插件生命周期之外，窗口无法通过拥有 profile 的管理器列出或移除它，而且该包还要进入核心包集合、desktop patch 与打包 family glob。若生成式插件无法通过 profile 校验，这是回退方案。
- **把 server 当作普通 npm 插件安装。** 否决：`.mcpb` 存在的意义就是让 server 自带依赖闭包并在宿主运行时下运行；走 registry 会让它依赖 npm 可用性与已发布的包名。
- **把包注册表放在 profile 之外并全部实时挂载。** 暂不采纳：它需要宿主侧 store 插件与桌面宿主所没有的控制通道，而其优势——免重启安装——价值低于复用窗口本就在执行的事务。

## 验收标准

1. 从插件窗安装一个 `.mcpb` 文件或 URL 后，其工具在下一轮对话即可调用，无需终端，也无需用户自装 Node。
2. 禁用一个包会移除其工具并保留文件；启用会恢复；移除会删除文件、profile 条目与注册表记录。
3. manifest 声明了宿主无法运行的 `server.type`、要求 `user_config`，或入口点逃出归档的包，会在安装时被拒绝，并在窗口中显示原因。
4. 卸载全部包后 profile 仍能启动，应用更新保留已安装的包。
5. 安装后的应用经由展开出的运行时访问该包：生成的插件从 `$DSH_HOME/closure/<版本>` 解析 `@deepseek-ai/dsh-mcp-client` 与共享包。

## 风险

- profile 校验放宽是生成式插件与已安装插件唯一的差异点；后续 pnpm 事务必须继续接受指向 profile 内部的 `file:` 条目，验收运行必须在装有包的情况下走一次运行时变更重建。
- 插件窗是唯一入口，因此无法启动的包只在那里可见，在重新考虑 Web 面之前没有第二处。
- 在打包应用真正安装一个真实包之前，这些都不算验证过：单元测试覆盖归档、manifest 与生成的插件，不覆盖组装后的挂载。
