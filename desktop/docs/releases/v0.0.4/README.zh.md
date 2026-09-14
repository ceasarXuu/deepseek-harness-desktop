# Desktop v0.0.4

[English](README.md) | 中文

Status: Proposed

首个基于上游桌面应用构建的桌面版本。应用本体来自上游；本版本加入本 fork 的运行时交付与自有发布目标。

## 本版本必须成立的内容

- 安装包以单个已验证归档携带生产依赖树——两个资源，而不是一万一千个散文件——首次启动在加载页显示确定进度，并把它展开到 `$DSH_HOME/closure/<版本>`。
- 首次启动后被修改、删除或新增的运行时文件会在下次启动被检出，应用从已验证归档重新展开，而不是信任现有依赖树。
- 发布以本仓库中的 `v<版本>` GitHub release 形式产生，已安装应用能发现它：预发布构建读取自己的 `<通道>-mac.yml`，稳定构建读取 `latest-mac.yml`。
- 签名 DMG 通过 Gatekeeper 并携带已装订的公证票据；其中的应用被判定为已公证。
- 应用从展开出的依赖树运行 harness，上游的 profile、插件事务与恢复操作保持不变。

## 本版本排除的内容

| 排除项 | 原因，以及在哪里重新考虑 |
|---|---|
| Windows 发布 | 签名需要连接在自托管 runner 上的 SafeNet 令牌。CI 只构建未签名安装包作为 workflow 产物，不触碰 release |
| 本 fork 的应用图标 | 启用它们会改变产物包，必须像其他产物改动一样验收；上游目前使用 Electron 默认图标 |
| 应用运行时安装插件包 | 上游基于内置 pnpm 的插件管理窗已覆盖该能力；休眠的 `plugin-store` 包留在工作区之外，直到 MCP 包面在那里重新表达 |
| 迁移早期桌面安装 | 尚无桌面版本发布，归档格式没有需要迁移的读取方 |

## 改动范围

| 领域 | 改动 | 归属 |
|---|---|---|
| 交付 | 运行时归档：打包、摘要、展开、自愈与进度上报 | `apps/desktop/src/runtime-closure.ts`、`apps/desktop/src/main.ts`、`apps/desktop/scripts/prepare-dsh.ts`、`apps/desktop/electron-builder.config.mjs` |
| 发布 | GitHub Releases 目标、带校验的上传、发布 workflow | `apps/desktop/scripts/desktop-auto-update-environment.mjs`、`apps/desktop/scripts/upload-target.ts`、`.github/workflows/desktop-release.yml` |
| 应用 | 采用上游实现，除交付与发布补丁外不做改动 | `apps/desktop`、`apps/desktop-host` |
| 删除 | 本 fork 的壳、组合包、闭包根及其构建入口 | — |

## 如何判定完成

1. 在 Apple Silicon 主机上执行 `pnpm run package:desktop:mac:arm64`，为预发布版本产出 DMG、ZIP、其 blockmap 与 `rc-mac.yml`。
2. DMG 通过 `spctl --assess --type open` 与 `xcrun stapler validate`；其中的应用通过 `codesign --verify --deep --strict` 与 Gatekeeper。
3. 首次启动显示带确定进度条的加载页，随后打开工作区；闭包目录包含 11226 个文件和一个 `.complete` 标记。
4. 改动闭包下的文件后，下次启动会重新展开归档：被改文件恢复为记录内容，新增文件消失。
5. `GH_TOKEN=… pnpm run upload:mac:arm64` 在 tag 尚无 release 时创建 release，上传各产物，并最后上传频道元数据。
