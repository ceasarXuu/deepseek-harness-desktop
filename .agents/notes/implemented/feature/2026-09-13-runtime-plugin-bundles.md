# Agent Note: Runtime plugin bundles in the desktop application

Status: implemented

English | [中文](2026-09-13-runtime-plugin-bundles.zh.md)

## Problem

The desktop application carries a frozen closure. That is what makes it installable on a machine with no Node.js and no package manager, and it is also why the first release excluded in-application plugin installation outright: the only way to change what the application can do was to build and ship a new version of it.

Every comparable application solves the same problem the same way. VS Code installs `.vsix` archives into `~/.vscode/extensions` and runs them in a separate extension host process, so "a misbehaving extension cannot impact VS Code". Claude Desktop installs `.mcpb` bundles — a zip holding a manifest, the server, and its bundled `node_modules` — and runs each one as a child process with the runtime the application already carries. Codex and ChatGPT Desktop configure MCP servers, which are processes too. None of them runs a package manager inside the application, and none of them writes a plugin into its own signed bundle.

The application already had the load-bearing half of that design and was not using it. [`packages/mcp/mcp-client`](../../../../packages/mcp/mcp-client/README.md) spawns an external MCP server, discovers its tools, registers each as a native tool under `mcp__<server>__<tool>`, and supervises reconnection — and no bundle mounted it. A plugin installed at run time needed a store to place it and a row to mount it, not a new protocol.

## Decision

### A plugin is a self-contained bundle, installed outside the application

The store installs the MCP Bundle format (`.mcpb`, formerly `.dxt`): one zip holding `manifest.json`, the server, and its `node_modules`. Adopting the published format rather than inventing one means the toolchain authors already use (`mcpb init` / `mcpb pack`) produces a bundle this application runs, and a bundle built for another host is readable here.

Bundles live under `$DSH_HOME/plugins/<id>/<version>/`, which is outside the signed application and outside the paths an update replaces. Nothing is written into the application bundle: the closure keeps its archive, its signature, and its contents.

### The host supplies the runtime

A manifest states `mcp_config.command: "node"` as an intent, not as a path. The store maps it to this application's own binary re-entered as Node, and puts `ELECTRON_RUN_AS_NODE=1` on the child — the same mechanism the shell uses to launch the harness. A user therefore installs a Node plugin without having Node installed, which is the property that makes `.mcpb` bundles portable in the first place. `server.type` values this host cannot run (`python`, `uv`) are refused at install with the reason stated, rather than installed and failing on every launch.

### One enabled plugin is one mounted `mcp-client` instance

`PluginStore` reads its registry, and for each enabled entry mounts `@deepseek-ai/dsh-mcp-client` dynamically over the store's own context, configured from the manifest's `mcp_config` after `${__dirname}` and `${HOME}` substitution. Installing, enabling, and removing all take effect in the running application: the mount is added or disposed, and the tools appear or disappear with it.

### Failure is contained twice

A mount captures its own startup failure instead of letting the fiber's activation reject. That is deliberate: a rejected activation makes cordis roll the fiber back, and the rollback leaves a rejection of its own unhandled, which the packaged host's fail-loud handler would treat as a process failure. Capturing the failure, reporting it in the registry view, and disposing an ACTIVE fiber keeps plugin trouble inside the store.

The other half is the architecture itself: the plugin is a child process, so a crash, a hang, or an exhausted reconnect budget takes down that plugin's tools and nothing else. The store reports the state; the host keeps running.

### The interface reaches the store over its own loopback routes

`PluginStore` registers `/desktop/plugins` on the composition's own webserver through the documented route extension point, and refuses any request that did not arrive over loopback. The panel is a browser plugin in the desktop subtree that fetches those routes; the file dialog it needs comes from the shell over the existing preload bridge. No privileged RPC domain was added, so no upstream package was edited for the interface.

## Alternatives considered

**Install cordis plugins in-process, as a patch layer.** This is the smallest change on paper — the harness already composes patch layers, and an installed bundle could contribute one. Rejected: in-process plugin code shares the harness's lifetime and privileges, so a plugin crash becomes an application crash, and the application would have needed its own trust story for arbitrary code rather than the process boundary every comparable application uses.

**Run a package manager inside the application.** Rejected: it is the one thing no comparable application does. It would put `pnpm` (about 20 MB) in the artifact, make an install depend on transitive dependency resolution the application would then own, and buy nothing that a self-contained bundle does not already provide — `mcpb pack` and `vsce package` exist precisely to move that work to the publisher.

**Extract the closure into a real directory so plugin resolution is ordinary.** Rejected: it changes the artifact's install story (a first-run extraction of roughly 355 MB) to solve a problem the bundle format does not have. Plugins are separate programs; they never need to resolve anything from the harness.

**A curated registry, as Claude Desktop ships.** Deferred rather than rejected: it is the natural next step once bundles exist, and it needs a publishing story this change does not have.

## Consequences

**Bought**: capability can be added to an installed application without building a release; a plugin's crash, hang, or reconnect exhaustion stays inside its own process; bundles survive application updates because they live outside the bundle; the install experience of the application itself is unchanged, and the closure was not touched.

**Paid**: a plugin is a separate process, so what it can contribute is what the process boundary carries — today its tools. It cannot add interface surfaces, prompt sections, or composition rows, which in-process plugins can. MCP's Resources and Prompts stay unbridged, as they already were. A bundle that wants interactive configuration (`user_config`) is refused rather than installed half-configured. Nothing verifies a publisher's identity: the store checks structure and the declared platform, not who signed the archive, and the panel says so before installing.

**Known limitation**: the panel and the store ship in the desktop subtree, so their behavior is verified by the subtree's own tests and by the packaged application, not by the harness's per-file coverage gate.

## Testing

`desktop/packages/plugin-store/tests/` covers manifest validation (required fields, unsupported server kinds, path escapes, `user_config` refusal, platform overrides), archive safety (traversal names, non-archives, missing manifests, extraction replacement), the store end to end (install, a real tool call across the process boundary, disable, enable, uninstall, a plugin that cannot start, a bundle whose entry point is absent), and the route surface over real HTTP.

One case installs a genuinely external package: `@modelcontextprotocol/server-everything` is packed with its resolved dependency closure into a bundle and installed, which exercises the same path a published third-party bundle takes. `desktop/packages/plugin-store/tests/support/bundles.ts` performs that packing, including the symlink resolution a package manager's layout requires.
