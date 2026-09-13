# Desktop v0.0.2

English | [中文](README.zh.md)

Status: Proposed

The second desktop release of DeepSeek Harness: the same signed, self-contained macOS application, with the ability to install and remove plugins while it runs.

## What this version must make true

A user can add capability to an installed application without a new build of that application being released, and can take it away again.

Concretely, with the application running:

- The Plugins panel lists what is installed, what is running, and what failed.
- A plugin bundle chosen from disk, or fetched from a URL, installs without a terminal and without restarting the application.
- The tools a plugin exposes become callable by the agent immediately after it installs.
- Disabling a plugin removes its tools; enabling it restores them.
- Removing a plugin deletes its files and its record, and leaves conversations and settings untouched.
- A plugin that crashes, hangs, or cannot start affects neither the application nor any other plugin.
- An installed plugin survives an application update, because it lives outside the application bundle.

## What this version excludes

| Excluded | Why, and where it is reconsidered |
|---|---|
| Plugin bundles that need a runtime this application does not carry (`python`, `uv`) | The application ships no Python runtime. Refused at install with the reason stated, rather than installed and failing later. |
| Interactive plugin configuration (`user_config`) | Collecting values for a bundle at install time needs a settings surface of its own. A bundle that requires it is refused rather than installed half-configured. |
| A plugin directory or marketplace | Bundles are installed from a file or a URL. Discovery needs a publishing story this version does not have. |
| Bridging MCP Resources and Prompts | The MCP client bridges tools; the other two capabilities have no consumer in the harness yet. |
| Plugin code inside the harness process | A plugin is a separate program. What it can contribute is what crosses that process boundary — today its tools. |
| Publisher identity verification | No signature is checked. The interface states that a plugin is an outside program before installing it. |
| In-application update | Unchanged from v0.0.1: the update feed is published, but the application does not yet consume it. Tracked as its own change; it and this feature both alter the boot path. |

## Scope of change

| Area | Change | Owner |
|---|---|---|
| Plugin store | New: bundle validation, installation, the installed registry, and live mount/unmount | `desktop/packages/plugin-store` |
| Plugins panel | New: an Installed tab in Web Settings driving the store's routes | `desktop/packages/ui-plugin-store` |
| Bundle choice | The shell answers a file-dialog request from the panel | `desktop/apps/shell` |
| Composition | Two rows, and the plugin packages added to the closure manifest | `desktop/packages/bundle-desktop-app`, `desktop/runtime-closure` |
| Mounting external servers | Reused unchanged | `packages/mcp/mcp-client` |

Nothing is installed into the signed application, and the closure's own contents are fixed at build time exactly as before.

## How completion is observed

1. With the application running, installing a bundle from the panel makes its tools callable in the next turn.
2. Disabling the plugin removes those tools; enabling it restores them.
3. Removing the plugin deletes `$DSH_HOME/plugins/<id>` and its registry entry.
4. A bundle whose server exits immediately is recorded as failed, with the reason in the panel, and the application keeps running.
5. Killing a mounted plugin's server process leaves the application running; the store reconnects it, and the panel shows the outage.
6. Updating the application preserves installed plugins.
7. The artifact still installs by dragging one application out of one DMG: no new first-run step, and no new file count.
