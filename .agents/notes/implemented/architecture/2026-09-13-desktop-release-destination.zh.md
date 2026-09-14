# Agent Note: 从本仓库发布 Desktop 版本

Status: implemented

[English](2026-09-13-desktop-release-destination.md) | 中文

消费该发布的应用程序是[采用的上游应用](2026-09-13-adopt-upstream-desktop.zh.md)；一次发布携带的内容是[运行时归档](2026-09-13-desktop-runtime-archive.zh.md)。

## 问题

打包应用在窗口打开后检查更新，因此它需要一个本 fork 能发布、应用能读取的目标。上游的目标两者都不满足：`download.deepseek.com` 提供上游自己的构建，其上传路径需要本 fork 并不持有的腾讯 COS 凭据。本 fork 无法发布的目标会让每次发布都退化为手工分发，而应用无法读取的目标则让安装包完全没有更新路径。

## 决策

一次 Desktop 发布就是本 fork 维护的仓库 `ceasarXuu/deepseek-harness-desktop` 中的一个 GitHub release，更新源使用 electron-updater 的 GitHub provider。

- `electron-builder.config.mjs` 以 `provider: 'github'` 与仓库坐标发布，而更新器所需的两个文件由打包步骤自己写出：应用资源中的 `app-update.yml`（含仓库与发布类型），以及产物旁的该版本频道元数据。之所以两者都自己写，是因为 electron-builder 只在构建安装器目标的那一趟产出它们，而本应用是从已打包目录构建安装器的；交给 electron-builder 的话，已安装应用会完全没有更新源，发布出的元数据也不指向任何产物。
- release 的 tag 是 `v<版本>`。provider 按语义版本比较 release tag，并从版本自身的预发布段推导预发布通道，因此 `0.1.5-rc.2` 在 tag `v0.1.5-rc.2` 下发布 `rc-mac.yml`，而 rc 构建的更新器查找的正是该通道文件。稳定版本发布 `latest-mac.yml`，而 GitHub 的 `releases/latest` 永不选择预发布。更新检查读取仓库公开的 releases feed 与 `releases/latest`，不经过 API，因此不消耗 API 配额。
- [`upload-target.ts`](../../../../apps/desktop/scripts/upload-target.ts)通过 GitHub REST API 以 `GH_TOKEN` 或 `GITHUB_TOKEN` 上传。它先验证本地产物——完成记录、版本、频道元数据、大小、SHA-512——再在 tag 尚无 release 时创建 release、按版本设置预发布标记、替换同名资源，并最后上传频道元数据，使读者不会看到指向尚不存在产物的元数据。
- [`desktop-release.yml`](../../../../.github/workflows/desktop-release.yml)在托管 runner 上构建两个 macOS 目标，将签名证书导入临时钥匙串，用 App Store Connect 密钥公证，对刚产出的产物验证签名、Gatekeeper 与装订票据，并且只在 `v*` tag 或显式手动运行时发布。它的 tag 守卫会拒绝未指明被打包版本的 tag，因为更新器在该 tag 内解析 `<通道>-mac.yml`。

`DSH_DESKTOP_UPDATE_REPOSITORY` 为测试环境指定仓库，因此本地或预发布运行不会误发布到生产仓库。

## 考虑过的替代方案

- **保留腾讯 COS 目标。** 否决：它需要只有上游持有的凭据，以及本 fork 必须自行运行的 HTTP origin。用仓库自身承载可以同时消除两者。
- **在固定 origin 上使用 generic provider。** 否决：它从单一稳定 URL 获取通道文件，而 GitHub 按 tag 提供资源。只有 `latest` 能解析，因此当前版本所需的预发布通道无法存在。
- **频道元数据放 GitHub Pages、产物放 releases。** 否决：通道文件中的产物路径是相对其自身 URL 的，从 Pages 发布意味着把它们改写为绝对资源 URL，并让第二套部署与每次发布保持同步。
- **交给 electron-builder 发布（`--publish always`）。** 否决：打包路径刻意关闭发布，因为上传会验证只有在签名与公证成功后才写出的完成记录、比对产物大小与摘要、并保证频道元数据最后上传。electron-builder 自带的发布器不做任何这些。
- **先用草稿 release，再手工发布。** 否决：更新器忽略草稿，因此被遗忘的第二步会表现为一次从未到达用户的发布。
- **使用私有发布仓库。** 否决：未认证的更新检查无法读取私有仓库，应用也没有可用于读取的凭据。

## 影响

仓库的 releases 即更新源，因此它必须保持公开，且其 tag 必须指明版本：tag 与被打包版本不一致时更新检查会以通道文件错误失败，workflow 的守卫会在任何内容发布前捕获这一点。

两个 macOS 通道运行在托管 runner 上，都需要把签名证书与公证密钥作为 `desktop-release` 环境的 secret。两个通道都使用 Apple Silicon 镜像：x64 通道在其中通过 Rosetta 运行自己的 x64 工具链，因为 Intel macOS runner 标签正在退役。

Windows 目前无法从 CI 发布：上游的签名路径需要连接在自托管 runner 上的 SafeNet 令牌，因此 Windows 通道只构建未签名安装包作为 workflow 产物，不触碰任何 release。Windows 发布在该 runner 出现前一直受阻。

上传使用 workflow 自身的令牌，它需要本仓库的 `contents: write` 权限——发布任务申请该权限，workflow 其余部分不申请。
