/**
 * The installed-plugin record: what `installed.json` holds, and the layout it
 * describes on disk.
 *
 * The file is the single source of truth for which plugins exist, which are
 * enabled, and where their bytes are; the harness reads it at boot, so a write
 * that left it half-updated would decide what the next launch mounts.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/registry
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PluginError } from './manifest.ts'

/** The registry file's name inside the plugin directory. */
export const REGISTRY_FILENAME = 'installed.json'

/** The registry format this version writes. */
const REGISTRY_FORMAT = 1

/** Where an installed plugin came from, kept for display. */
export interface PluginSource {
  /** A file the user picked, or a URL it was downloaded from. */
  kind: 'file' | 'url'
  /** The absolute path or the URL. */
  value: string
}

/** One installed plugin. */
export interface InstalledPlugin {
  /** Install identity, derived from the manifest name. */
  id: string
  /** Human name shown in the interface. */
  displayName: string
  /** The installed version. */
  version: string
  /** The namespace its tools are registered under. */
  serverName: string
  /** Whether the harness mounts it at boot. */
  enabled: boolean
  /** One-line description from the manifest. */
  description: string
  /** Author name from the manifest, possibly empty. */
  author: string
  /** Homepage from the manifest, when it declared one. */
  homepage?: string
  /** Where it was installed from. */
  source: PluginSource
  /** When it was installed, as an ISO timestamp. */
  installedAt: string
  /** Platforms the manifest declared; empty means all. */
  platforms: readonly string[]
  /** The Node range the manifest declared, shown rather than enforced. */
  nodeRange?: string
  /** The application range the manifest declared, shown rather than enforced. */
  appRange?: string
}

/** The registry file's contents. */
export interface PluginRegistry {
  /** Format marker, so a future version can refuse an older layout loudly. */
  version: number
  /** Every installed plugin, in install order. */
  plugins: InstalledPlugin[]
}

/** The empty registry. */
export function emptyRegistry(): PluginRegistry {
  return { version: REGISTRY_FORMAT, plugins: [] }
}

/**
 * Read `installed.json`, treating absence as the empty registry.
 * @param directory - the plugin directory.
 * @returns the parsed registry.
 */
export function readRegistry(directory: string): PluginRegistry {
  const path = join(directory, REGISTRY_FILENAME)
  if (!existsSync(path)) return emptyRegistry()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    throw new PluginError('io-failed', `${path} is not readable JSON`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginError('io-failed', `${path} must hold a JSON object`)
  }
  const record = parsed as Partial<PluginRegistry>
  if (record.version !== REGISTRY_FORMAT || !Array.isArray(record.plugins)) {
    throw new PluginError('io-failed', `${path} was written by a different plugin-store format`)
  }
  return { version: REGISTRY_FORMAT, plugins: record.plugins }
}

/**
 * Write the registry atomically.
 * @param directory - the plugin directory.
 * @param registry - the next contents.
 * @returns after the replacement is in place.
 */
export async function writeRegistry(directory: string, registry: PluginRegistry): Promise<void> {
  mkdirSync(directory, { recursive: true })
  await writeFileAtomic(
    join(directory, REGISTRY_FILENAME),
    `${JSON.stringify(registry, null, 2)}\n`,
    { mode: 0o600, dirMode: 0o700 },
  )
}

/**
 * The directory one installed version occupies.
 * @param directory - the plugin directory.
 * @param id - the plugin's install identity.
 * @param version - the installed version.
 * @returns the absolute path of that version's tree.
 */
export function versionDirectory(directory: string, id: string, version: string): string {
  return join(directory, id, version)
}

/**
 * The directory a plugin's versions live under.
 * @param directory - the plugin directory.
 * @param id - the plugin's install identity.
 * @returns the absolute path of the plugin's own directory.
 */
export function pluginDirectory(directory: string, id: string): string {
  return join(directory, id)
}

/**
 * Remove every version of a plugin except the one being kept.
 * @param directory - the plugin directory.
 * @param id - the plugin's install identity.
 * @param keep - the directory to preserve, or `undefined` to remove all.
 */
export function pruneVersions(directory: string, id: string, keep: string | undefined): void {
  const versions = join(directory, id)
  if (!existsSync(versions)) return
  if (keep === undefined) {
    rmSync(versions, { recursive: true, force: true })
    return
  }
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    const path = join(versions, entry.name)
    if (path !== keep) rmSync(path, { recursive: true, force: true })
  }
}
