# 桌面版发布

[English](README.md) | 中文

每个已发布的桌面版本占一个目录，存放该版本的规划集：包含什么、如何构建与分发，以及可能出什么问题。

发布目录描述的是预期状态，在版本发布前会持续修订。发布后的行为随后由产出的包 README 和 Agent Note 负责；发布目录则作为该版本当初目标的记录保留下来。

| 版本 | 状态 | 目标 | 文档 |
|---|---|---|---|
| 0.0.1 | 提案中 | macOS（Apple Silicon） | [`v0.0.1`](v0.0.1/README.zh.md) |
| 0.0.2 | 提案中 | macOS（Apple Silicon） | [`v0.0.2`](v0.0.2/README.zh.md) |
| 0.0.4 | 提案中 | macOS（Apple Silicon、Intel） | [`v0.0.4`](v0.0.4/README.zh.md) |

## 发布内各文档的职责

| 文档 | 回答的问题 |
|---|---|
| `README.md` | 本版本承诺什么、排除什么，以及如何判定完成 |
| `architecture.md` | 进程如何编排，harness 如何启动 |
| `packaging.md` | 应用包内含什么，以及如何签名 |
| `distribution.md` | 版本号如何管理、如何发布，以及如何就地更新 |
| `experience.md` | 不使用终端的用户看到什么 |
| `plan.md` | 工作顺序与每个阶段的退出标准 |
| `risks.md` | 哪些尚未验证、可能失败什么，以及每种回退方案是什么 |
