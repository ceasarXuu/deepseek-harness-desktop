#!/usr/bin/env node
/**
 * Packaged harness entry. Boots the desktop composition from the frozen
 * dependency closure it ships inside, with no profile directory, no launcher,
 * and no package manager involved.
 *
 * The command-line launcher is deliberately not reused: it installs a
 * process-exiting handler and force-mounts an HMR service, both of which belong
 * to an interactive terminal application rather than to a supervised child.
 *
 * @module @deepseek-ai/dsh-desktop-app/entry
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, composeEntries, healProfilesModuleFallback, initProfile, installFailLoud, loadEnv, loadOptionalPatches, watchUserPatches } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Process name used in diagnostics and environment loading. */
const NAME = 'dsh-desktop'

/**
 * Bundle layers, in application order. `dsh-desktop-app` patches over the two
 * it composes with, so the browser roster and the agent-preset plane arrive
 * from `dsh-web-app` rather than being restated.
 */
const BUNDLES = ['dsh-base', 'dsh-web-app', 'dsh-desktop-app'] as const

/**
 * The shipped agent-preset roster, relative to the built entry.
 *
 * A preset IS a session's agent composition, so a composition that reaches
 * `session.create` with an empty roster cannot open a session at all: the
 * request carries only a workspace, and resolving the default preset is what
 * turns it into an agent.
 *
 * Every launcher resolves this root for the same reason, and none of them
 * restates the roster: `apps/cli` reads it beside its own config, and this
 * entry reads it from the package that ships it in the closure. The desktop
 * closure declares `@deepseek-ai/dsh` as a direct dependency, so the roster
 * arrives with the closure rather than being copied into a second place that
 * would drift from the first.
 */
const SHIPPED_PRESET_ROOT_RELATIVE = '../../dsh/config/agent-presets/'

/** The telemetry row id the `DSH_TELEMETRY_DISABLED` switch targets, as the launcher spells it. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Locate the shipped agent-preset roster and fail loud when it is absent.
 *
 * Silence here is the failure mode: an empty roster rejects every
 * `session.create` with `agent-preset-not-found`, which surfaces in the client
 * as a workspace picker that closes without selecting anything.
 * @param entryUrl - this module's URL, the resolution anchor.
 * @returns the absolute roster path.
 */
function shippedPresetRoot(entryUrl: string): string {
  const path = fileURLToPath(new URL(SHIPPED_PRESET_ROOT_RELATIVE, entryUrl))
  if (!existsSync(path)) {
    throw new Error(`${NAME}: shipped agent-preset roster not found at ${path}`)
  }
  return path
}

/**
 * The overlays this entry adds over the composed bundle layers.
 *
 * Both exist because a launcher normally adds them and this entry is the
 * launcher. They are appended after the layers so they win, and each replaces
 * the whole `config` of the row it targets — hence the composed row is read
 * first and its keys restated rather than dropped.
 * @param patches - the composed bundle layers, in application order.
 * @param entryUrl - this module's URL, the resolution anchor.
 * @returns the overlay list, possibly empty.
 */
function launcherOverlays(patches: readonly PatchOptions[], entryUrl: string): PatchOptions[] {
  const rows = new Map<string, ReturnType<typeof composeEntries>[number]>()
  for (const row of composeEntries([[...patches]])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const overlays: PatchOptions[] = []
  const presetRow = rows.get('agent-presets')
  if (presetRow !== undefined) {
    overlays.push({
      id: 'agent-presets',
      config: { ...presetRow.config, roots: [{ path: shippedPresetRoot(entryUrl), trust: 'system' }] },
    })
  }
  // The environment is inherited rather than owned: a `DSH_TELEMETRY_MODE` set
  // for another tool would otherwise re-enable collection in a process whose
  // own switch says it is off.
  if ((process.env['DSH_TELEMETRY_DISABLED'] ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }
  return overlays
}

/**
 * Read one bundle's patch layer from the closure the entry runs inside.
 *
 * Bundles are sibling packages under the same scope directory, so the path is
 * derived from this module's own location rather than from a configured root:
 * a frozen closure has no installation directory to consult. The built entry
 * sits at `<closure>/node_modules/@deepseek-ai/dsh-desktop-app/lib/entry.js`,
 * so `../../<bundle>` reaches a sibling's package root.
 * @param entryUrl - this module's URL, the resolution anchor.
 * @param bundle - the unscoped bundle package name.
 * @returns the parsed patch layer, or an empty list when the bundle ships none.
 */
function loadBundlePatch(entryUrl: string, bundle: string): PatchOptions[] {
  const patchUrl = new URL(`../../${bundle}/cordis.patch.yml`, entryUrl)
  return loadOptionalPatches(NAME, fileURLToPath(patchUrl)) ?? []
}

/**
 * The profile this application installs into, and the patches that compose it.
 *
 * A desktop user has no terminal, so the profile is the application's own: it
 * is where a plugin installed from the interface lands, and it is the module
 * resolution base — a bare specifier in a composition row resolves from here,
 * then from the flat fallback directory beside it, and the fallback is what
 * makes the packages the application already carries reachable. Without a base
 * of its own, an installed plugin could never resolve the framework it shares
 * with the host, which is the whole reason the closure is an ordinary
 * directory rather than an archive.
 *
 * The fallback is healed from the CLOSURE's manifest rather than from the
 * launcher's: the closure is the list of everything this application carries,
 * including the packages only the desktop composition mounts.
 */
interface DesktopProfile {
  /** The profile directory, which also holds installed plugins. */
  directory: string
  /** The root config file bare specifiers resolve against. */
  rootConfig: string
  /** Patch layers the user owns: the profile's own file, then the harness home's. */
  userPatches: PatchOptions[]
  /** The files those patches came from, for live reconciliation. */
  userPatchFiles: string[]
}

/**
 * Prepare the profile: create it when absent, heal the fallback, read the user layers.
 * @param entryUrl - this module's URL, the anchor for the closure it runs inside.
 * @param home - the harness home.
 * @returns the profile description.
 */
function prepareDesktopProfile(entryUrl: string, home: string): DesktopProfile {
  const directory = join(home, 'profiles', 'desktop')
  initProfile(directory, [])
  // The root include needs a real file to anchor resolution at; the CLI writes
  // the same empty list for the same reason.
  const rootConfig = join(directory, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  const closureManifest = fileURLToPath(new URL('../../../../package.json', entryUrl))
  healProfilesModuleFallback(closureManifest, home)
  const userPatchFiles = [join(directory, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]
  const userPatches = userPatchFiles.flatMap(file => loadOptionalPatches(NAME, file) ?? [])
  return { directory, rootConfig, userPatches, userPatchFiles }
}

/**
 * Boot the desktop composition and own process exit.
 * @param entryUrl - this module's URL, used as the base for bare-specifier
 * resolution so plugins come from the closure rather than from the caller.
 * @returns after the tree is mounted; process lifetime then belongs to signals.
 */
export async function runDesktopHarness(entryUrl: string): Promise<void> {
  installFailLoud(NAME)
  loadEnv(NAME)

  const layers = BUNDLES.flatMap(bundle => loadBundlePatch(entryUrl, bundle))
  const home = resolveDshHome()
  const profile = prepareDesktopProfile(entryUrl, home)
  // The launcher's own overlays sit above the shipped layers and below the
  // user's, so a user patch can override any row the application ships.
  const patches = [...layers, ...launcherOverlays(layers, entryUrl), ...profile.userPatches]

  const ctx = await boot(NAME, profile.rootConfig, patches, (hostCtx) => {
    // The web-startup row parses the command line and the transport rows inject
    // the service it provides. An embedding host contributes no arguments: the
    // desktop patch states the bind configuration in the composition instead.
    provideCmdline(hostCtx, {
      args: [],
      exit: (code: number) => {
        void ctx.fiber.dispose().finally(() => process.exit(code))
      },
    })
  }, pathToFileURL(profile.rootConfig).href)

  // The user's layers are watched, as they are under the command-line
  // launcher: editing one hot-applies instead of requiring a restart.
  for (const file of profile.userPatchFiles) {
    void watchUserPatches(ctx as Context, { binName: NAME, filename: file }).catch(() => {})
  }

  // The shell supervises this process: it disposes the tree on a stop request
  // so persistence drains, rather than leaving the log truncated at the point
  // the signal arrived.
  let stopping = false
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    void ctx.fiber.dispose().finally(() => process.exit(code))
  }
  process.on('SIGTERM', () => { stop(0) })
  process.on('SIGINT', () => { stop(130) })
}

/* v8 ignore next -- exercised through the packaged closure acceptance path */
await runDesktopHarness(import.meta.url)
