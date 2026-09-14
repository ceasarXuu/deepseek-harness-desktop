# Agent Note: Install MCP bundles in the adopted Desktop application

Status: implemented

English | [中文](2026-09-14-desktop-mcp-bundle-install.zh.md)

The application this changes is the [adopted upstream application](../architecture/2026-09-13-adopt-upstream-desktop.md); what a bundle's server runs on is the [runtime archive](../architecture/2026-09-13-desktop-runtime-archive.md).

## Problem

The adopted application's plugin manager installs npm plugins but had no path to an MCP server package, and the fork's own implementation of one — `desktop/packages/plugin-store` and `desktop/packages/ui-plugin-store` — is dormant, because every surface it used is gone: the packages register REST routes through `ctx.webServer`, which the desktop composition disables, and the Web panel reads `globalThis.dshShell.pickPluginBundle`, a bridge the deleted fork shell exposed rather than the `dshDesktop` bridge the adopted shell exposes.

What they carried is the capability itself: install a `.mcpb` bundle (a zip holding `manifest.json`, the server, and its `node_modules`) from a file or a URL, run its server with the application's own binary re-entered as Node, and expose its tools as `mcp__<server>__<tool>` without the user installing Node or a package manager. `@deepseek-ai/dsh-mcp-client` is already in the bundled runtime and linked into the profile, so the host half exists; only the installation and the mount needed to be added.

## Decision

An MCP bundle becomes a generated desktop plugin, so the adopted application's own plugin machinery installs, validates, mounts, and removes it. The unpacking, the registry, and the plugin generator live in `apps/desktop/src/mcp-bundles.ts`.

### Install unpacks the archive and generates the plugin

Installing a `.mcpb` file or URL unpacks the archive into `$DSH_HOME/plugins/<id>/<version>/` and generates the plugin beside it in the profile. The generated `package.json` declares `peerDependencies` on the shared host packages and `dsh.bundle.patch`, and the plugin carries a `cordis.patch.yml` whose row runs the application's own binary re-entered as Node with `ELECTRON_RUN_AS_NODE=1` and mounts `@deepseek-ai/dsh-mcp-client` with the manifest's `mcp_config`. The profile manifest records the entry as `dependencies: {"<id>": "file:./plugins/<id>"}` at the enabled version, and the generated plugin name is appended to `dsh.profile.bundles`. That `file:` dependency is the one relaxation this needs: `projectManifest` accepted exact registry versions only, and now also accepts an entry that points inside the profile. Installed bundles are recorded in the registry `installed.json` under `$DSH_HOME/plugins/`.

### Mounting runs through the application's existing transaction

Mounting is the application's existing transaction: the plugin window stops the backend, the profile changes, the backend starts, and the composition mounts the bundle's row. There is no live mount, no new host protocol, and no new host package — the mount path is the one every installed plugin already takes.

### Running keeps the fork's runtime rule

`command: "node"` in a manifest is an intent, so the patch names the application's Node re-entered with `ELECTRON_RUN_AS_NODE`. A bundle whose manifest names a `server.type` this host cannot run (`python`, `uv`), requires `user_config`, or whose entry point escapes the archive is refused at install with the reason shown in the window. The generated plugin resolves `@deepseek-ai/dsh-mcp-client` and the shared packages from the expanded runtime at `$DSH_HOME/closure/<version>`.

### Removal follows the plugin lifecycle

Removing deletes the generated plugin, drops the profile entry, prunes the bundle's versions, removes the payload directory and the registry record, and the backend restart unmounts its tools. Disabling keeps the files, as disabling a plugin does.

### The plugin window gains an MCP bundles section

The plugin window has a second section, "MCP bundles", listing installed bundles with their state and tools, with an install form (a file chooser through a bridge method plus a URL field) and enable/disable and remove actions, all through named IPC channels like the plugin section above it. Every string is in both locale dictionaries, and the section states that a bundle is an outside program before it installs.

## Verification

A packaged mac-arm64 application installed a real `.mcpb` fixture: the store wrote `$DSH_HOME/plugins/<id>/<version>/`, the registry `installed.json`, the generated plugin (`package.json` with `peerDependencies` on `@deepseek-ai/dsh-mcp-client` and `dsh.bundle.patch`, plus a `cordis.patch.yml` whose row runs the application's Node with `ELECTRON_RUN_AS_NODE=1`), and the profile manifest entry `dependencies: {"dsh-mcp-bundle-echo": "file:./plugins/echo"}` with the generated plugin appended to `dsh.profile.bundles`. On the next start the MCP server's own log recorded its argv, `initialize`, `notifications/initialized`, and `tools/list`, and the window reached the application rather than the failure page. Disabling dropped the profile entry and the next start produced no new handshake. Removing deleted the payload directory and the registry entry while the application still started. `apps/desktop/tests/mcp-bundles.spec.ts` covers the archive, the manifest, and the generated plugin.

## Alternatives considered

- **Port `plugin-store` onto `/api/*` routes and install `ui-plugin-store` in the Web settings section again.** Rejected: the desktop host renders `/api/*` as the Typert RPC surface plus explicitly registered fetch routes, so this means a host-side service, a client package served from `/plugins/…`, and a live mount that survives profile validation — three new surfaces against one generated directory and one validation relaxation.
- **Ship a new host-side package and mount it from the desktop patch layer.** Rejected: this is the design a bundle-as-plugin cannot use — a hand-written package in the profile is outside the plugin lifecycle, so the window could not list or remove it through the manager that owns the profile, and the package would have to enter the core set, the desktop patch, and the packaging family globs. It remains the fallback if a generated plugin cannot satisfy profile validation.
- **Install the server as an npm package like any plugin.** Rejected: `.mcpb` bundles exist so that a server ships with its dependency closure and runs under the host's runtime; routing them through the registry would make them depend on npm availability and on a published package name.
- **Keep the bundle registry outside the profile and mount everything live.** Rejected: it needs a host-side store plugin plus a control channel the desktop host does not have, and its advantage — installing without a restart — is worth less than reusing the transaction the window already performs.

## Consequences

**Bought**: a packaged application installs a `.mcpb` file or URL and its tools become callable in the next turn, with no terminal and no user-installed Node; the install rides the plugin transaction the window already performs, so there is no live mount and no new host package; bundles live outside the signed application, so they survive an application update; and uninstalling every bundle leaves a profile that still boots.

**Paid**: the profile validation relaxation is the one place a generated plugin differs from an installed one, so a later pnpm transaction must keep accepting `file:` entries that point inside the profile. The plugin window is the only entry point, so a bundle that cannot start is visible there and nowhere else until the Web surface is revisited.

**Not yet covered**: a runtime-change rebuild with a bundle installed has not been exercised, so whether that transaction keeps the relaxed `file:` entry is unverified. Survival of an installed bundle across a real application update is likewise unverified — the packaged run started the application after a removal, not after an update. The assembled mount is verified by the packaged run above; the unit tests in `apps/desktop/tests/mcp-bundles.spec.ts` cover the archive, the manifest, and the generated plugin rather than the composition.
