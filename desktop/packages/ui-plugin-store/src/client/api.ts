/**
 * The panel's view of the desktop plugin store, over the store's own routes.
 *
 * These routes are served by the harness on the same loopback origin the
 * interface is loaded from, so the panel needs no privileged RPC domain: it
 * fetches `/desktop/plugins/...` directly. The prefix is stated here rather
 * than imported from the store, because a browser bundle and a host package
 * are separate programs and the client bundle cannot carry host values.
 *
 * @module @deepseek-ai/dsh-desktop-ui-plugin-store/client/api
 */

/** Where the store's routes live; owned by `@deepseek-ai/dsh-desktop-plugin-store`. */
const ROUTE_PREFIX = '/desktop/plugins'

/** One installed plugin as the store reports it. */
export interface PluginView {
  /** Install identity. */
  id: string
  /** Human name. */
  displayName: string
  /** Installed version. */
  version: string
  /** One-line description. */
  description: string
  /** Author name, possibly empty. */
  author: string
  /** Homepage, when the bundle declared one. */
  homepage?: string
  /** Where it came from. */
  source: { kind: 'file' | 'url'; value: string }
  /** When it was installed. */
  installedAt: string
  /** Whether the store mounts it. */
  enabled: boolean
  /** `mounted`, `disabled`, or `failed`. */
  state: 'mounted' | 'disabled' | 'failed'
  /** Why it is not running, when it is not. */
  detail?: string
  /** The model-facing tool names it contributed. */
  tools: readonly string[]
}

/** The whole list answer. */
export interface PluginList {
  /** The plugin directory, shown so a user can find the files. */
  directory: string
  /** Every installed plugin. */
  plugins: PluginView[]
}

/** One refusal from the store, carrying its stable code. */
export class PluginRequestError extends Error {
  /** The store's error code, when it sent one. */
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/**
 * Send one request to the store and return its decoded answer.
 * @param path - the path below {@link ROUTE_PREFIX}.
 * @param init - request options; a body is JSON-encoded by the caller.
 * @returns the decoded body.
 */
async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${ROUTE_PREFIX}${path}`, init)
  } catch (error: unknown) {
    throw new PluginRequestError(error instanceof Error ? error.message : String(error))
  }
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) {
    throw new PluginRequestError(
      typeof body['error'] === 'string' ? body['error'] : `the plugin store refused the request (HTTP ${String(response.status)})`,
      typeof body['code'] === 'string' ? body['code'] : undefined,
    )
  }
  return body
}

/** POST a JSON command to one route. */
async function command(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** Read every installed plugin with its live state. */
export async function listPlugins(): Promise<PluginList> {
  const body = await request('')
  return {
    directory: String(body['directory'] ?? ''),
    plugins: (body['plugins'] ?? []) as PluginView[],
  }
}

/**
 * Install a bundle from a path on this machine.
 * @param path - the bundle file's absolute path.
 * @returns the installed plugin.
 */
export async function installFromFile(path: string): Promise<PluginView> {
  return (await command('/install', { path }))['plugin'] as PluginView
}

/**
 * Install a bundle from an http(s) URL.
 * @param url - the bundle's URL.
 * @returns the installed plugin.
 */
export async function installFromUrl(url: string): Promise<PluginView> {
  return (await command('/install', { url }))['plugin'] as PluginView
}

/**
 * Start or stop an installed plugin.
 * @param id - the plugin's install identity.
 * @param enabled - the state to move it to.
 * @returns the plugin afterwards.
 */
export async function setEnabled(id: string, enabled: boolean): Promise<PluginView> {
  return (await command('/set-enabled', { id, enabled }))['plugin'] as PluginView
}

/**
 * Remove an installed plugin and everything it wrote.
 * @param id - the plugin's install identity.
 */
export async function uninstall(id: string): Promise<void> {
  await command('/uninstall', { id })
}
