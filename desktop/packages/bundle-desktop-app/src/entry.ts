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

import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
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

/** Where the shipped root configuration sits, relative to the built entry. */
const CONFIG_RELATIVE_PATH = '../config/cordis.yml'

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
 * Boot the desktop composition and own process exit.
 * @param entryUrl - this module's URL, used as the base for bare-specifier
 * resolution so plugins come from the closure rather than from the caller.
 * @returns after the tree is mounted; process lifetime then belongs to signals.
 */
export async function runDesktopHarness(entryUrl: string): Promise<void> {
  installFailLoud(NAME)
  loadEnv(NAME)

  const patches = BUNDLES.flatMap(bundle => loadBundlePatch(entryUrl, bundle))
  const configPath = fileURLToPath(new URL(CONFIG_RELATIVE_PATH, entryUrl))

  const ctx = await boot(NAME, configPath, patches, (hostCtx) => {
    // The web-startup row parses the command line and the transport rows inject
    // the service it provides. An embedding host contributes no arguments: the
    // desktop patch states the bind configuration in the composition instead.
    provideCmdline(hostCtx, {
      args: [],
      exit: (code: number) => {
        void ctx.fiber.dispose().finally(() => process.exit(code))
      },
    })
  }, entryUrl)

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
