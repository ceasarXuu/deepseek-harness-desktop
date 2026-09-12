# Architecture

Status: Proposed

This document describes the process arrangement, the choice of runtime that executes the harness, the boot sequence, the plugin composition, and the on-disk locations the application owns.

## The controlling decision: the harness runs in a child process

The harness does not execute inside the Electron main process. Four harness contracts make an in-main-process boot unsafe, and each is load-bearing rather than incidental.

**The terminal capability loads a native addon eagerly.** [`packages/subprocess/subprocess-local/src/index.ts`](../../../../packages/subprocess/subprocess-local/src/index.ts) opens with `import * as nodePty from 'node-pty'`, and the base composition mounts that plugin unconditionally ([`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) row `subprocess`). The binding therefore loads during tree construction, before any tool runs. A native addon is bound to one `NODE_MODULE_VERSION`, and Electron's differs from a stock Node build.

**Bare-specifier plugin resolution requires Loader internals.** [`vendor/loader/src/config/tree.ts`](../../../../vendor/loader/src/config/tree.ts) resolves every entry through `this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})` when internals are available. When they are not, bare specifiers fall through to a plain `import(name)` that resolves relative to the vendored loader's own location rather than the configuration, so a composed tree of `@deepseek-ai/dsh-*` names does not resolve. [`packages/boot/app-boot/README.md`](../../../../packages/boot/app-boot/README.md) states this as a contract: bare specifiers depend on Loader internals, and a production binary needs the native helper or an equivalent resolution hook.

**The profile launcher installs a process-wide fail-loud handler.** [`apps/cli/src/profile-boot.ts`](../../../../apps/cli/src/profile-boot.ts) calls `installFailLoud`, which registers `process.on('unhandledRejection', …)` and terminates the process with `exit(1)` ([`packages/boot/app-boot/src/index.ts`](../../../../packages/boot/app-boot/src/index.ts)). On a shared main process, one unhandled rejection anywhere ends the application.

**The profile launcher force-mounts an HMR service.** After boot, `runProfile` mounts `@deepseek-ai/cordis-plugin-hmr` when no `hmr` service exists, and that service's constructor throws when Loader internals are absent ([`vendor/hmr/src/index.ts`](../../../../vendor/hmr/src/index.ts)). Disabling the `hmr` row is therefore not sufficient; the launcher itself must be bypassed.

Running the harness in a child process removes all four constraints at once. It also gives the application a restartable, observable unit: a crash in the harness ends one child process, which the shell reports and can restart, rather than ending the application.

**The shell never calls `runProfile`.** It calls `boot()` from [`packages/boot/app-boot`](../../../../packages/boot/app-boot/README.md) directly, which means it also never touches `$DSH_HOME/profiles`. Profiles are a launcher convenience over `boot()`, not a requirement of it. `apps/cli/src/plugin.ts` is the only place in the repository that spawns a package manager, and the shell does not expose that path, so the packaged application contains no package-manager dependency.

## Runtime carrier

The child process needs a Node runtime that satisfies the repository engine floor of `^22.19.0 || >=24.0.0` and exposes `node:zlib` zstd and `node:sqlite`. Three carriers can supply it, and the release selects one.

| Carrier | Satisfies the floor | Extra payload | Native-addon consequence |
|---|---|---|---|
| Electron's own Node, launched with `ELECTRON_RUN_AS_NODE=1` | Electron 44.3.0 ships Node 24.20.0 | None | None: the packaged addon is N-API and loads without a rebuild |
| A bundled official Node binary | Chosen by the build | One Node runtime per architecture | The same N-API addon loads there too |
| The `pkg --sea` single-file executable | Fixed at the node24 target | One executable carrying a VFS | `node-pty` is staged as a sibling, as the executable build already does |

**Selection: Electron's own Node, with a bundled official Node binary as the fallback.**

The selection is driven by two facts. First, Electron 44.3.0's bundled Node 24.20.0 satisfies the engine floor without shipping a second runtime, which keeps the application bundle roughly one Node runtime smaller than the alternatives. Second, the `node-pty` patch already anticipates this shape: [`patches/node-pty@1.1.0.patch`](../../../../patches/node-pty@1.1.0.patch) adds a `DSH_NODE_PTY_SPAWN_HELPER` environment variable and, absent it, probes `process.execPath + '-spawn-helper'`, which is the Electron binary path rather than a sibling of the addon.

The carrier is isolated behind one module in the shell that produces an executable path and an argument vector. Switching carriers changes that module and the packaging rules, not the boot sequence or the composition.

### The carrier, measured

The spike ran the Electron binary as a Node child and recorded what follows. Each value is reproducible with `ELECTRON_RUN_AS_NODE=1` against the packaged binary.

| Property | Measured |
|---|---|
| Electron | 44.3.0 |
| Bundled Node | 24.20.0, which satisfies `^22.19.0 \|\| >=24.0.0` |
| `node:zlib` `zstdCompress` | Present, so the default JSONL persistence backend imports cleanly |
| `node:sqlite` | Available |
| Native module version | 149 |

The native module version is recorded because it is what an addon must match; the packaged addon turns out not to depend on it, for the reason below.

### Reaching Loader internals without a native addon

[`vendor/loader/src/internal.ts`](../../../../vendor/loader/src/internal.ts) offers two routes to Node's internal ESM loader. The first is the `node-addon-require-builtin` native addon. The second is the `--expose-internals` Node flag, which the module checks first:

```ts
if (process.execArgv.includes('--expose-internals')) {
  try { return require(id) } catch {}
}
```

The child process is launched with `--expose-internals`, which removes `node-addon-require-builtin` from the packaged artifact entirely. The spike confirmed both directions in an Electron child: with the flag, `internal/modules/esm/loader` resolves and `getOrInitializeCascadedLoader()` returns a loader; without it, the same require fails with `MODULE_NOT_FOUND`.

`--expose-internals` is a stock Node flag and the harness already depends on internals by design, so this adds no new class of coupling. The harness's own README documents the dependency.

### The terminal addon needs no rebuild

`node-pty` builds against `node-addon-api`, so its prebuilt `pty.node` is an N-API addon rather than one bound to a module version. The spike loaded the prebuild shipped in the repository's dependency tree — the one built for stock Node — under the Electron child, opened a PTY, and read the command's output back, with no recompilation.

This removes a build stage rather than deferring it: Electron's native module version never enters the picture for this addon, so the packaging step that other Electron applications spend on `electron-rebuild` has nothing to do here. The addon still must be unpacked outside `asar` and keep its executable helper, which are packaging constraints rather than ABI ones.

## Process model

```
┌─────────────────────────────────────────────────────────┐
│ Electron main process                                    │
│  · application menu, single-instance lock, quit          │
│  · spawns and supervises the harness child               │
│  · native dialogs (workspace selection, save panels)     │
│  · electron-updater                                      │
└───────────────┬─────────────────────────────────────────┘
                │ spawn: ELECTRON_RUN_AS_NODE=1 --expose-internals
                │        <bundled entry> --port 0
                ▼
┌─────────────────────────────────────────────────────────┐
│ Harness child process (Node, not Chromium)               │
│  · boot() → Cordis tree → agent loop, tools, sessions    │
│  · node:http server on an ephemeral 127.0.0.1 port       │
│  · owns DSH_HOME: sessions, credentials, settings        │
│  · writes one machine-readable readiness line to stdout   │
└───────────────┬─────────────────────────────────────────┘
                │ loopback HTTP + WebSocket
                ▼
┌─────────────────────────────────────────────────────────┐
│ Renderer (Chromium)                                      │
│  · loads http://127.0.0.1:<port>                         │
│  · the shipped browser client, unmodified                │
└─────────────────────────────────────────────────────────┘
```

The renderer loads the interface over loopback HTTP rather than a custom protocol. This keeps the shipped client transport, the plugin bundle route, the boot-manifest index tap, and the loopback trust fence working exactly as they do in a browser, with no changes to [`packages/client/connection`](../../../../packages/client/connection/README.md) or [`packages/client/modules`](../../../../packages/client/modules/README.md). The alternative is described under Deferred work.

The server binds `127.0.0.1` with `port: 0`, so the operating system assigns a free port and the shell reads the bound value from `ctx.webServer.port` ([`packages/host/webserver`](../../../../packages/host/webserver/README.md)). This makes concurrent instances and port conflicts impossible rather than unlikely, and it removes the need for a fixed port in the packaged application.

## Boot sequence

1. The shell acquires a single-instance lock and exits if another instance holds it.
2. The shell resolves `DSH_HOME` under the application's data directory and passes it in the child's environment.
3. The shell spawns the harness child with `ELECTRON_RUN_AS_NODE=1`, `--expose-internals`, the workspace path as the working directory, and the shipped configuration path.
4. The child calls `boot(binName, configPath, patches, prepare, bareModuleBaseUrl)` with the packaged closure as the bare-module base, so bare specifiers resolve from the application's own dependency tree rather than from the configuration's location.
5. The child mounts the desktop bundle, which mounts `dsh-base` plus the desktop patch layer.
6. The child's own `web-runtime` equivalent resolves the built frontend `dist/index.html` and mounts the static handler as the server's fallback seat.
7. The server binds `127.0.0.1:0`; the child reads the assigned port.
8. The child writes one machine-readable readiness line containing the port to stdout.
9. The shell reads that line and points the window at `http://127.0.0.1:<port>`.
10. On quit, the shell signals the child, which disposes the Cordis tree so persistence drains, then exits.

Step 8 replaces the URL line that [`packages/bundle/web-app`](../../../../packages/bundle/web-app/README.md) prints for browsers. That line is not usable in an application window, so the desktop bundle disables it and emits a structured readiness record instead. Runtime output captured from stdout and stderr is also what feeds the diagnostics surface described in [`experience.md`](experience.md).

## Composition

The desktop application composes `@deepseek-ai/dsh-base` plus a new bundle that supplies desktop behavior, mirroring how `@deepseek-ai/dsh-web-app` layers over the same base.

| Row | Origin | Desktop override |
|---|---|---|
| `hmr` | base | Disabled. A packaged application has no source tree to watch. |
| `client-hmr` | web-app equivalent | Not mounted. The client rebuild watcher has no purpose without a watch process. |
| `webserver` | base | `host: '127.0.0.1'`, `port: 0`. |
| `session-query-sqlite` | base | Kept inert at `openAt: never`, as the base and web compositions ship it. Enabling full-text session search is out of scope for this version. |
| `agent-presets` | base | The shipped preset root is injected as a build-time path rather than a URL relative to a launcher. |
| URL line | web-app | Disabled; replaced by the structured readiness record. |
| Directory picker | web-app | An Electron-backed provider replaces the host-native provider. |
| `session-persistence-jsonl` | base | Root redirected under the application's `DSH_HOME`. |

The bundle declares `dsh.bundle.patch` in its `package.json` and is resolved through the same `resolveBundleDir` probe path used by shipped bundles, so it is packaged and verified by the existing configuration checks rather than by desktop-specific tooling.

Two rows require new code rather than configuration.

**The directory picker.** [`packages/host/directory-picker-native`](../../../../packages/host/directory-picker-native/README.md) spawns `osascript` to present a folder chooser. That works, but it is a separate process presenting a dialog whose parent window the harness cannot control, which produces a dialog that can appear behind the application window. The capabilities document for this seam names Electron as an intended native provider, so the desktop composition supplies one backed by `dialog.showOpenDialog` and leaves the existing provider packages unmodified.

**Diagnostics.** The harness's own logger output is captured by the shell and forwarded to the renderer, and the agent-error state that the runtime already records is rendered. See [`experience.md`](experience.md).

## On-disk locations

Everything the application writes lives under `DSH_HOME`, which the shell sets to a directory inside the macOS application support directory rather than the `~/.dsh` default.

| Data | Location | Owner |
|---|---|---|
| Sessions (JSONL, zstd) | `<DSH_HOME>/sessions` | [`packages/session/session-persistence-jsonl`](../../../../packages/session/session-persistence-jsonl/README.md) |
| Settings | `<DSH_HOME>/settings.yaml` | [`packages/settings/settings-file`](../../../../packages/settings/settings-file/README.md) |
| Credentials | `<DSH_HOME>/.credentials.yaml` | [`packages/credentials/credentials-local`](../../../../packages/credentials/credentials-local/README.md) |
| Attachments | `<DSH_HOME>/attachments/v1` | [`packages/attachment/attachment-local`](../../../../packages/attachment/attachment-local/README.md) |
| Agent presets | `<DSH_HOME>/.agent-presets` | [`packages/preset/agent-presets`](../../../../packages/preset/agent-presets/README.md) |
| Application code and closure | Application bundle, read-only | This subtree |

Credentials reach the harness through the existing managed store, which the shipped Models interface writes. This release requires no environment variable for a credential and no file the user edits by hand, which is what makes the interface-only onboarding in [`experience.md`](experience.md) possible.

## Deferred work

Two changes are deliberately out of scope for this version and are recorded here so the boundaries of the shipped design are explicit.

**Custom protocol and IPC transport.** The application could serve the frontend over a registered scheme and carry requests over Electron IPC instead of loopback HTTP, removing the listening socket. That change touches four seams in [`packages/client/connection`](../../../../packages/client/connection/README.md) and [`packages/host/apiproxy`](../../../../packages/host/apiproxy/README.md): the base-URL derivation, the two WebSocket downlinks, and the generic RPC caller. It also requires replicating the boot-manifest index tap and the plugin bundle route. Loopback HTTP is kept for this version because it requires no harness changes at all.

**Multiple windows.** The process model is one window per harness child. More than one concurrent window would need either one child per window, with a shared `DSH_HOME`, or a single child serving multiple windows. Neither is needed for a first release.
