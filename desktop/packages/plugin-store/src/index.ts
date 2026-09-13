/**
 * `@deepseek-ai/dsh-desktop-plugin-store` — the desktop application's runtime
 * plugin installer.
 *
 * An installed plugin is a self-contained bundle (the MCP Bundle format: one
 * zip holding `manifest.json`, the server, and its bundled dependencies) that
 * runs as its own child process, exactly as VS Code runs an extension in its
 * own process and Claude Desktop runs a bundle's server. Nothing is installed
 * into the signed application: bundles live under `$DSH_HOME/plugins` and are
 * mounted through the harness's own `mcp-client`, so their tools reach the
 * model under `mcp__<plugin>__<tool>` and their crashes reach nobody else.
 *
 * The interface talks to this plugin over its own loopback routes
 * ({@link module:@deepseek-ai/dsh-desktop-plugin-store/routes}).
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { registerPluginRoutes } from './routes.ts'
import { PluginStore } from './store.ts'
import type { StoreConfig } from './store.ts'

export type { PluginState, PluginView, StoreConfig } from './store.ts'
export type { InstalledPlugin, PluginRegistry, PluginSource } from './registry.ts'
export type { ResolvedManifest } from './manifest.ts'
export { PluginError } from './manifest.ts'
export type { PluginErrorCode } from './manifest.ts'
export { PluginStore } from './store.ts'
export { ROUTE_PREFIX, registerPluginRoutes } from './routes.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'desktop-plugin-store'

/** The route surface needs a listening server; mounting needs nothing else. */
export const inject = ['webServer']

/** Plugin configuration; both fields default to this application's own paths. */
export interface Config extends StoreConfig {}

/**
 * Register the plugin store: mount what is enabled, then serve the panel.
 * @param ctx - plugin context.
 * @param config - optional directory and runtime overrides, for tests.
 * @returns after the enabled plugins have settled.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const store = new PluginStore(ctx, config)
  ctx.effect(function* () {
    yield async () => { await store.dispose() }
  }, 'desktop plugin store')
  ctx.effect(() => registerPluginRoutes(ctx, store), 'desktop plugin routes')
  await store.start()
}
