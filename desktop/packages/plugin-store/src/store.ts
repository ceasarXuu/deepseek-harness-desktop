/**
 * The installed-plugin store: which plugins exist, installing and removing
 * them, and the live `mcp-client` instance each enabled plugin owns.
 *
 * Two owners meet here. The registry file is the persistent record, written
 * only through the atomic writer because the next boot reads it. The mount map
 * is the live half: one dynamically mounted plugin per enabled entry, disposed
 * before its bytes are touched so no running server is left reading a removed
 * directory.
 *
 * A plugin failing is never the host's failure. Every mount is awaited and
 * caught, and the reason is kept for the interface; the composition boots with
 * or without any given plugin.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { downloadBundle, extractBundle, openBundle } from './bundle.ts'
import type { ResolvedManifest } from './manifest.ts'
import { PluginError, checkPlatformCompatibility, parseManifest, toServerName } from './manifest.ts'
import type { InstalledPlugin, PluginRegistry, PluginSource } from './registry.ts'
import { pruneVersions, readRegistry, versionDirectory, writeRegistry } from './registry.ts'
import { planSpawn } from './spawn.ts'

/** Where a plugin stands right now. */
export type PluginState = 'mounted' | 'disabled' | 'failed'

/** One plugin as the interface sees it: the record plus its live state. */
export interface PluginView extends InstalledPlugin {
  /** Whether its server is currently running. */
  state: PluginState
  /** Why it is not running, when it is not. */
  detail?: string
  /** The model-facing tool names it contributed, when it is mounted. */
  tools: readonly string[]
}

/** Store configuration, all optional and defaulted for this application. */
export interface StoreConfig {
  /** The plugin directory; defaults to `$DSH_HOME/plugins`. */
  directory?: string
  /** The binary used to run `node` servers; defaults to this process's own. */
  runtime?: string
}

/** One live instance: the fiber to dispose and the namespace it claimed. */
interface Mount {
  fiber: Fiber
  serverName: string
}

/** Prefix `mcp-client` builds its public tool names with. */
const TOOL_PREFIX = 'mcp__'

/**
 * The store. One instance per plugin context; every mutation goes through it so
 * the registry file and the mount map cannot disagree.
 */
export class PluginStore {
  private readonly ctx: Context
  private readonly directory: string
  private readonly runtime: string
  private readonly mounts = new Map<string, Mount>()
  private readonly failures = new Map<string, string>()
  private disposed = false

  constructor(ctx: Context, config: StoreConfig = {}) {
    this.ctx = ctx
    this.directory = config.directory ?? dshHomePath('plugins')
    this.runtime = config.runtime ?? process.execPath
  }

  /** The directory every installed plugin lives under. */
  get root(): string {
    return this.directory
  }

  /**
   * Mount every enabled plugin in the registry, reporting rather than throwing
   * on each failure.
   * @returns after each mount has settled.
   */
  async start(): Promise<void> {
    mkdirSync(this.directory, { recursive: true })
    for (const plugin of readRegistry(this.directory).plugins) {
      if (!plugin.enabled) continue
      await this.mount(plugin)
    }
  }

  /** List every installed plugin with its live state. */
  list(): PluginView[] {
    return readRegistry(this.directory).plugins.map(plugin => this.view(plugin))
  }

  /**
   * Install from a file on disk.
   * @param path - the bundle's absolute path.
   * @returns the installed plugin.
   */
  async installFromFile(path: string): Promise<PluginView> {
    if (!existsSync(path)) throw new PluginError('not-found', `no file at ${path}`)
    return await this.install(new Uint8Array(readFileSync(path)), { kind: 'file', value: path })
  }

  /**
   * Install from an http(s) URL.
   * @param url - the bundle's URL.
   * @returns the installed plugin.
   */
  async installFromUrl(url: string): Promise<PluginView> {
    return await this.install(await downloadBundle(url), { kind: 'url', value: url })
  }

  /**
   * Remove a plugin: its running server, its bytes, and its record.
   * @param id - the plugin's install identity.
   * @returns after the directory and the record are both gone.
   */
  async uninstall(id: string): Promise<void> {
    const registry = readRegistry(this.directory)
    const plugin = registry.plugins.find(entry => entry.id === id)
    if (plugin === undefined) throw new PluginError('not-found', `no plugin installed as "${id}"`)
    await this.unmount(id)
    pruneVersions(this.directory, id, undefined)
    this.failures.delete(id)
    await writeRegistry(this.directory, {
      version: registry.version,
      plugins: registry.plugins.filter(entry => entry.id !== id),
    })
  }

  /**
   * Stop or start a plugin without removing it.
   * @param id - the plugin's install identity.
   * @param enabled - the state to move it to.
   * @returns the plugin afterwards.
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginView> {
    const registry = readRegistry(this.directory)
    const plugin = registry.plugins.find(entry => entry.id === id)
    if (plugin === undefined) throw new PluginError('not-found', `no plugin installed as "${id}"`)
    plugin.enabled = enabled
    await writeRegistry(this.directory, registry)
    if (enabled) await this.mount(plugin)
    else await this.unmount(id)
    return this.view(plugin)
  }

  /** Dispose every live server. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.mounts.keys()]) await this.unmount(id)
  }

  /**
   * Install already-downloaded bytes.
   * @param bytes - the bundle archive.
   * @param source - where it came from, recorded for display.
   * @returns the installed plugin.
   */
  private async install(bytes: Uint8Array, source: PluginSource): Promise<PluginView> {
    const archive = openBundle(bytes)
    const scripts = { home: homedir(), platform: process.platform }
    const probe = parseManifest(JSON.parse(archive.manifest), { dirname: this.directory, home: scripts.home }, scripts.platform)
    checkPlatformCompatibility(probe, scripts.platform)

    const target = versionDirectory(this.directory, probe.id, probe.version)
    const manifest = parseManifest(JSON.parse(archive.manifest), { dirname: target, home: scripts.home }, scripts.platform)
    // Planning here, before anything is written, is what makes an unrunnable
    // bundle a refusal rather than a plugin that appears and then fails.
    const staging = `${join(this.directory, probe.id)}/tmp-${String(process.pid)}-${String(Date.now())}`
    extractBundle(archive, staging)
    try {
      planSpawn(manifest, { directory: staging, runtime: this.runtime })
    } catch (error: unknown) {
      rmSync(staging, { recursive: true, force: true })
      try {
        // Only the directory this refusal created is removed; a plugin already
        // installed under the same id keeps its version, so a failed upgrade
        // cannot take a working install with it.
        rmdirSync(join(this.directory, probe.id))
      } catch {
        // The plugin has an installed version, so the directory stays.
      }
      throw error
    }

    await this.unmount(probe.id)
    mkdirSync(join(this.directory, probe.id), { recursive: true })
    renameSync(staging, target)
    pruneVersions(this.directory, probe.id, target)

    const registry = readRegistry(this.directory)
    const previous = registry.plugins.find(entry => entry.id === probe.id)
    const record: InstalledPlugin = {
      id: probe.id,
      displayName: probe.displayName,
      version: probe.version,
      serverName: previous?.serverName ?? toServerName(probe.id),
      enabled: previous?.enabled ?? true,
      description: probe.description,
      author: probe.author,
      ...(probe.homepage === undefined ? {} : { homepage: probe.homepage }),
      source,
      installedAt: new Date().toISOString(),
      platforms: probe.platforms,
      ...(probe.nodeRange === undefined ? {} : { nodeRange: probe.nodeRange }),
      ...(probe.appRange === undefined ? {} : { appRange: probe.appRange }),
    }
    const next: PluginRegistry = {
      version: registry.version,
      plugins: [...registry.plugins.filter(entry => entry.id !== probe.id), record],
    }
    await writeRegistry(this.directory, next)
    if (record.enabled) await this.mount(record)
    return this.view(record)
  }

  /**
   * Mount one plugin's server, recording rather than raising a failure.
   * @param plugin - the record to mount.
   */
  private async mount(plugin: InstalledPlugin): Promise<void> {
    if (this.disposed) return
    await this.unmount(plugin.id)
    try {
      const directory = versionDirectory(this.directory, plugin.id, plugin.version)
      const raw = readFileSync(join(directory, 'manifest.json'), 'utf8')
      const manifest: ResolvedManifest = parseManifest(
        JSON.parse(raw),
        { dirname: directory, home: homedir() },
        process.platform,
      )
      checkPlatformCompatibility(manifest, process.platform)
      const plan = planSpawn(manifest, { directory, runtime: this.runtime })
      const mcpClient = await import('@deepseek-ai/dsh-mcp-client')
      // The mount is wrapped so a failure to connect is captured HERE instead of
      // failing the fiber's activation. A failed activation makes cordis roll the
      // fiber back, and that rollback leaves a rejection of its own unhandled —
      // which the packaged host's fail-loud handler would take for a process
      // failure. Reporting the failure and disposing an ACTIVE fiber keeps plugin
      // trouble inside this store.
      let startupFailure: unknown
      const fiber = this.ctx.plugin({
        name: mcpClient.name,
        inject: mcpClient.inject,
        ...(mcpClient.Config === undefined ? {} : { Config: mcpClient.Config }),
        apply: async (child: Context, config: unknown): Promise<void> => {
          try {
            await mcpClient.apply(child, config as never)
          } catch (error: unknown) {
            startupFailure = error
          }
        },
      }, {
        transport: 'stdio',
        serverName: plugin.serverName,
        command: plan.command,
        args: [...plan.args],
        env: { ...plan.env },
        cwd: plan.cwd,
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      })
      await fiber.await()
      if (startupFailure !== undefined) {
        await fiber.dispose()
        throw startupFailure
      }
      this.mounts.set(plugin.id, { fiber, serverName: plugin.serverName })
      this.failures.delete(plugin.id)
    } catch (error: unknown) {
      this.failures.set(plugin.id, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Dispose one plugin's server if it has one.
   * @param id - the plugin's install identity.
   */
  private async unmount(id: string): Promise<void> {
    const mount = this.mounts.get(id)
    if (mount === undefined) return
    this.mounts.delete(id)
    await mount.fiber.dispose()
  }

  /**
   * Compose one plugin's view from its record and its live state.
   * @param plugin - the record.
   * @returns the view.
   */
  private view(plugin: InstalledPlugin): PluginView {
    const failure = this.failures.get(plugin.id)
    const mounted = this.mounts.has(plugin.id)
    const state: PluginState = mounted ? 'mounted' : failure === undefined ? 'disabled' : 'failed'
    return {
      ...plugin,
      state,
      ...(failure === undefined ? {} : { detail: failure }),
      tools: mounted ? this.toolsOf(plugin.serverName) : [],
    }
  }

  /**
   * The tool names a server contributed, read back from the registry it
   * registered them on rather than from what it declared.
   * @param serverName - the plugin's namespace.
   * @returns the model-facing tool names, sorted.
   */
  private toolsOf(serverName: string): string[] {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return []
    const prefix = `${TOOL_PREFIX}${serverName}__`
    return tools.schemas().map(schema => schema.name).filter(name => name.startsWith(prefix)).sort()
  }
}
