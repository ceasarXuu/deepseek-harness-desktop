/**
 * @deepseek-ai/dsh-desktop-app — the desktop distribution's bundle. The patch
 * (`cordis.patch.yml`, declared by `dsh.bundle.patch`) restates the three
 * decisions the browser deployment makes differently; this plugin is the
 * runtime glue those differences need, and `./entry` boots the frozen closure.
 *
 * @module @deepseek-ai/dsh-desktop-app
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'desktop-runtime'

/** The readiness record's stable prefix, so a supervisor can find the line among other output. */
export const READY_PREFIX = 'dsh-desktop-ready '

/** Services required before the readiness record can be resolved. */
export const inject = ['webServer']

/** One readiness line's payload. */
export interface Readiness {
  /** The loopback port the interface is served on. */
  port: number
  /** The canonical loopback URL, identical to what the window loads. */
  url: string
  /** The running harness's version, for the About surface and support. */
  version: string
}

/**
 * Emit one machine-readable readiness line on stdout.
 *
 * A supervisor reads this instead of the browser URL line: it carries the port
 * as a field rather than inside prose, and it is written after the Loader tree
 * settles so a sibling row cannot still be mounting when the window opens.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const report = (): void => {
    const server = ctx.get('webServer')
    // The tree can be disposed while the boot was in flight (an early signal);
    // a readiness line for a dead server would only mislead.
    if (server === undefined) return
    const payload: Readiness = {
      port: server.port,
      url: `http://127.0.0.1:${String(server.port)}`,
      version: process.env['DSH_DESKTOP_VERSION'] ?? '0.0.0',
    }
    process.stdout.write(READY_PREFIX + JSON.stringify(payload) + '\n')
  }

  // Without a Loader this is a hand-built tree and readiness is already true.
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) report()
  else void settled.then(report, () => {})
}
