# Desktop v0.0.1

English | [中文](README.zh.md)

Status: Proposed

The first desktop release of DeepSeek Harness: a macOS application delivered as a signed and notarized DMG that a user installs by dragging it to Applications and runs by double-clicking, with no terminal, no system Node.js, no package manager, and no separately started service.

## What this version must make true

An end user who has never opened a terminal can go from a downloaded DMG to a working coding agent, and can receive later official versions from inside the application.

Concretely, after installing and launching the application:

- The harness boots and serves its interface without the user installing or configuring anything beyond the application itself.
- The user selects a workspace folder with a native macOS dialog, and no path is typed.
- The user enters an API credential in the application's own interface, and it persists across launches.
- Conversations, tools, approvals, plans, and slash commands work as they do in the shipped browser interface.
- The agent can execute shell commands in the selected workspace, which requires no terminal to be opened by the user.
- A later official release is detected, downloaded, and applied from inside the application, and the application restarts into it.

## What this version excludes

| Excluded | Why, and where it is reconsidered |
|---|---|
| Windows and Linux builds | The release targets one platform to keep the signing, dependency, and verification surface small. Cross-platform packaging is deferred to the next release. |
| Intel Mac support | Apple Silicon only for the first release. Universal packaging doubles the native-artifact verification surface. |
| Removing the loopback HTTP server in favor of an IPC transport | The harness keeps its shipped transport for this version. The custom-protocol and IPC carrier path is described in [`architecture.md`](architecture.md) as a later change. |
| A terminal or TUI front end | The browser interface is the product surface. The harness ships no terminal UI package. |
| In-application plugin installation or a plugin marketplace | The packaged closure is frozen at build time. The shipped interface exposes a read-only plugin inventory. |
| A bundled model or an offline mode | The agent reaches the DeepSeek API over the network. No local inference is included. |
| Auto-update channels beyond stable | Only one feed is published and consumed. |

## Scope of change

This release adds a subtree and a small number of harness-side additions. It does not modify the agent loop, the session format, or any capability seam.

| Area | Change | Owner |
|---|---|---|
| Electron shell | New | `desktop/apps/shell` |
| Desktop bundle over `dsh-base` | New | `desktop/packages/bundle-desktop-app` |
| Packaged runtime closure | New | `desktop/packages/runtime-closure` |
| Build, signing, notarization, DMG | New | `desktop/build` |
| Workspace definition | `desktop/*` added to [`pnpm-workspace.yaml`](../../../../pnpm-workspace.yaml) | Root |
| Native directory picker in a packaged host | Replaced by an Electron-backed provider for this composition only; the existing provider packages are unchanged | Desktop bundle |
| Host diagnostics reaching the interface | New: captured runtime output and a rendered agent-error surface | Desktop bundle and shell |

## How completion is observed

Each item is checkable without reading the implementation.

1. A DMG built from a tagged commit installs on a macOS machine that has never had Node.js, pnpm, or this repository present.
2. `spctl --assess --type execute` accepts the installed application and `codesign --verify --deep --strict` passes.
3. Launching the application presents the interface within the startup budget recorded in [`plan.md`](plan.md), with no window that requires a terminal.
4. The onboarding flow accepts an API credential through the interface and a first turn completes.
5. The agent executes a shell command in the selected workspace and the result renders as a tool card.
6. Quitting the application terminates the harness process, with no orphaned process and no bound port left behind.
7. Publishing a higher version makes the running application offer that version, and accepting restarts into it with the workspace and conversation history intact.
8. The signing, notarization, and packaging steps run unattended in CI on a tagged commit.

## Documents

| Document | Contents |
|---|---|
| [`architecture.md`](architecture.md) | Process model, the runtime-carrier decision, boot sequence, composition, and on-disk locations |
| [`packaging.md`](packaging.md) | Application bundle layout, native artifacts, `asar` rules, signing, notarization, DMG |
| [`distribution.md`](distribution.md) | Versioning, the release pipeline, the update feed, and update behavior |
| [`experience.md`](experience.md) | First run, workspace and credential handling, lifecycle, and diagnostics for a user without a terminal |
| [`plan.md`](plan.md) | Stages, the Phase 0 spike, and exit criteria |
| [`risks.md`](risks.md) | Risk register, fallbacks, and open questions |
