# Agent Note: Install MCP bundles in the adopted Desktop application

Status: proposed

English | [中文](2026-09-14-desktop-mcp-bundle-install.zh.md)

The application this changes is the [adopted upstream application](../../implemented/architecture/2026-09-13-adopt-upstream-desktop.md); what a bundle's server runs on is the [runtime archive](../../implemented/architecture/2026-09-13-desktop-runtime-archive.md).

## Problem

The adopted application can install npm plugins but cannot install an MCP server package. `desktop/packages/plugin-store` and `desktop/packages/ui-plugin-store` — the fork's own implementation — are dormant, because every surface they used is gone: they register REST routes through `ctx.webServer`, which the desktop composition disables, and the Web panel reads `globalThis.dshShell.pickPluginBundle`, a bridge the deleted fork shell exposed rather than the `dshDesktop` bridge the adopted shell exposes.

What they carried is the capability itself: install a `.mcpb` bundle (a zip holding `manifest.json`, the server, and its `node_modules`) from a file or a URL, run its server with the application's own binary re-entered as Node, and expose its tools as `mcp__<server>__<tool>` without the user installing Node or a package manager. `@deepseek-ai/dsh-mcp-client` is already in the bundled runtime and linked into the profile, so the host half exists; only the installation and the mount are missing.

## Proposal

An MCP bundle becomes a generated desktop plugin, so the adopted application's own plugin machinery installs, validates, mounts, and removes it.

- **Install** unpacks the archive into `$DSH_HOME/plugins/<id>/<version>/` and generates the plugin beside it in the profile: `node_modules/<generated-name>/package.json` with `peerDependencies` on the shared host packages, a `dsh.bundle.patch` that mounts `@deepseek-ai/dsh-mcp-client` with the manifest's `mcp_config`, and the bundle's own files. The profile manifest records it as `file:./plugins/<id>` at the enabled version, which is the one relaxation this needs: `projectManifest` currently accepts exact registry versions only.
- **Mount** is the application's existing transaction: the plugin window stops the backend, the profile changes, the backend starts and the composition mounts the bundle's row. There is no live mount, no new host protocol, and no new host package — the mount path is the one every installed plugin already takes.
- **Run** keeps the fork's runtime rule: `command: "node"` in a manifest is an intent, so the patch names the application's Node re-entered with `ELECTRON_RUN_AS_NODE`, and `server.type` values this host cannot run (`python`, `uv`) are refused at install with the reason stated.
- **Remove** deletes the generated plugin, drops the profile entry, prunes the bundle's versions, and the backend restart unmounts its tools. Disabling keeps the files, as disabling a plugin does.

The plugin window gains a second section listing installed bundles with their state and tools, an install form (file chooser through a new bridge method plus a URL field), and enable/disable and remove actions, all through named IPC channels like the plugin section above it. Every string is added to both locale dictionaries, and the section states that a bundle is an outside program before it installs.

## Alternatives considered

- **Port `plugin-store` onto `/api/*` routes and install `ui-plugin-store` in the Web settings section again.** Rejected: the desktop host renders `/api/*` as the Typert RPC surface plus explicitly registered fetch routes, so this means a host-side service, a client package served from `/plugins/…`, and a live mount that survives profile validation — three new surfaces against one generated directory and one validation relaxation.
- **Ship a new host-side package and mount it from the desktop patch layer.** This is the design a bundle-as-plugin cannot use: a hand-written package in the profile is outside the plugin lifecycle, so the window could not list or remove it through the manager that owns the profile, and the package would have to enter the core set, the desktop patch, and the packaging family globs. It remains the fallback if a generated plugin cannot satisfy profile validation.
- **Install the server as an npm package like any plugin.** Rejected: `.mcpb` bundles exist so that a server ships with its dependency closure and runs under the host's runtime; routing them through the registry would make them depend on npm availability and on a published package name.
- **Keep the bundle registry outside the profile and mount everything live.** Rejected for now: it needs a host-side store plugin plus a control channel the desktop host does not have, and its advantage — installing without a restart — is worth less than reusing the transaction the window already performs.

## Acceptance criteria

1. Installing a `.mcpb` file or URL from the plugin window makes its tools callable in the next turn, with no terminal and no user-installed Node.
2. Disabling a bundle removes its tools and keeps its files; enabling it restores them; removing it deletes the files, the profile entry, and the registry record.
3. A bundle whose manifest names a `server.type` this host cannot run, requires `user_config`, or whose entry point escapes the archive is refused at install with the reason shown in the window.
4. Uninstalling every bundle leaves a profile that still boots, and an application update keeps installed bundles.
5. The installed application reaches the bundle through the expanded runtime: the generated plugin resolves `@deepseek-ai/dsh-mcp-client` and the shared packages from `$DSH_HOME/closure/<version>`.

## Risks

- The profile validation relaxation is the one place a generated plugin differs from an installed one; a later pnpm transaction must keep accepting `file:` entries pointing inside the profile, and the acceptance run has to exercise a runtime-change rebuild with a bundle installed.
- The plugin window is the only entry point, so a bundle that cannot start is visible there and nowhere else until the Web surface is revisited.
- Nothing here is verified until a packaged application installs a real bundle; the unit tests cover the archive, manifest, and generated plugin, not the assembled mount.
