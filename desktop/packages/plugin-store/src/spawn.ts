/**
 * Turning an installed plugin into the process `mcp-client` launches.
 *
 * A bundle never names the runtime itself. The MCP Bundle specification treats
 * `mcp_config.command` as a statement of intent (`"node"`), and the host is
 * expected to supply a runtime it already carries — which is what lets a user
 * install a Node plugin on a machine that has no Node installed. Here that
 * runtime is this application's own binary, re-entered as Node, exactly as the
 * shell launches the harness itself.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/spawn
 */

import { accessSync, constants, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ResolvedManifest } from './manifest.ts'
import { PluginError } from './manifest.ts'

/** How one plugin's server process is launched. */
export interface SpawnPlan {
  /** Executable to spawn. */
  command: string
  /** Arguments passed to it, without shell interpretation. */
  args: readonly string[]
  /** Environment merged over the scrubbed ambient environment. */
  env: Readonly<Record<string, string>>
  /** Working directory for the server process. */
  cwd: string
}

/** What planning a spawn needs beyond the manifest. */
export interface SpawnContext {
  /** The absolute directory the installed version occupies. */
  directory: string
  /** The binary to use for `node` servers. */
  runtime: string
}

/**
 * Plan the server process for one installed plugin.
 * @param manifest - the validated manifest of the installed version.
 * @param context - the installation's runtime and directory.
 * @returns the launch plan for `mcp-client`.
 */
export function planSpawn(manifest: ResolvedManifest, context: SpawnContext): SpawnPlan {
  if (manifest.serverType === 'node') {
    // The declared entry point is checked even when `mcp_config` names its own
    // argv: a bundle that carries no server would otherwise install and fail
    // on every launch instead of being refused once.
    const entry = insideBundle(manifest, context, manifest.entryPoint)
    return {
      command: context.runtime,
      args: manifest.args.length > 0 ? manifest.args : [entry],
      env: { ELECTRON_RUN_AS_NODE: '1', ...manifest.env },
      cwd: context.directory,
    }
  }
  return {
    command: insideBundle(manifest, context, manifest.command ?? manifest.entryPoint, true),
    args: manifest.args,
    env: { ...manifest.env },
    cwd: context.directory,
  }
}

/**
 * Resolve a path the manifest states against the installed directory, refusing
 * anything that leaves it or is not there.
 * @param manifest - the manifest, for the refusal message.
 * @param context - the installed directory.
 * @param declared - the path the manifest declared, already substituted.
 * @param requireExecutable - whether the result must be runnable.
 * @returns the absolute path.
 */
function insideBundle(
  manifest: ResolvedManifest,
  context: SpawnContext,
  declared: string,
  requireExecutable = false,
): string {
  const path = isAbsolute(declared) ? declared : join(context.directory, declared)
  if (!path.startsWith(context.directory)) {
    throw new PluginError('bundle-invalid', `"${declared}" points outside the plugin's own directory`)
  }
  if (!existsSync(path)) {
    throw new PluginError('bundle-invalid', `the bundle is missing ${manifest.serverType === 'node' ? 'its entry point' : 'its executable'}: ${declared}`)
  }
  if (requireExecutable) {
    try {
      accessSync(path, constants.X_OK)
    } catch (error: unknown) {
      throw new PluginError('bundle-invalid', `the bundle's executable is not runnable: ${declared}`, { cause: error })
    }
  }
  return path
}
