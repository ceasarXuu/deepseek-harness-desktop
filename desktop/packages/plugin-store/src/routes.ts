/**
 * The store's HTTP surface, served on the interface's own loopback origin.
 *
 * The panel is the only client, so the surface is deliberately small and
 * answers JSON: list, install from a path or a URL, uninstall, and enable or
 * disable. Every route refuses a request that did not arrive over loopback,
 * because installing a plugin writes an executable program to disk.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginView, PluginStore } from './store.ts'
import { PluginError } from './manifest.ts'
import type { PluginErrorCode } from './manifest.ts'

/** Panel-facing prefix; the composition's webserver owns everything under it. */
export const ROUTE_PREFIX = '/desktop/plugins'

/** The command routes below {@link ROUTE_PREFIX}; anything else is a 404. */
const COMMANDS = new Set(['/install', '/uninstall', '/set-enabled'])

/** Most bytes one request body may hold. */
const MAX_BODY_BYTES = 64 * 1024

/** Map a refusal to the HTTP status the panel renders. */
const STATUS_BY_CODE: Readonly<Record<PluginErrorCode, number>> = {
  'bundle-invalid': 400,
  'manifest-invalid': 400,
  'server-unsupported': 400,
  'incompatible': 400,
  'user-config-required': 400,
  'already-installed': 409,
  'not-found': 404,
  'io-failed': 502,
}

/**
 * Decide whether a request came from this machine.
 *
 * The desktop composition binds loopback, but the check is repeated here so a
 * deployment that binds wider cannot reach an installer that writes and runs
 * programs.
 * @param req - the incoming request.
 * @returns true when the peer is loopback.
 */
function fromLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Read a JSON request body within the cap.
 * @param req - the incoming request.
 * @returns the parsed body.
 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new PluginError('io-failed', 'the request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginError('io-failed', 'the request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Read a required string field from a request body. */
function stringArgument(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value === '') throw new PluginError('io-failed', `"${field}" is required`)
  return value
}

/** One plugin list payload. */
interface ListPayload {
  /** The plugin directory, shown so a user can find the files. */
  directory: string
  /** Every installed plugin with its live state. */
  plugins: PluginView[]
}

/**
 * Register the store's routes on the composition's webserver.
 * @param ctx - plugin context carrying the webserver.
 * @param store - the store the routes act on.
 * @returns the disposer removing the route.
 */
export function registerPluginRoutes(ctx: Context, store: PluginStore): () => void {
  const server = ctx.get('webServer')
  if (server === undefined) throw new Error('desktop-plugin-store: the webServer service is required')

  return server.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!fromLoopback(req)) {
        send(res, 403, { error: 'plugin installation is available over loopback only' })
        return
      }
      const path = (req.url ?? '').split('?')[0]?.slice(ROUTE_PREFIX.length) ?? ''
      try {
        await dispatch(store, req, res, path)
      } catch (error: unknown) {
        const code = error instanceof PluginError ? error.code : 'io-failed'
        send(res, STATUS_BY_CODE[code], { code, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/**
 * Route one request to the store call it names.
 * @param store - the store.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param path - the path below {@link ROUTE_PREFIX}.
 * @returns after the response is written.
 */
async function dispatch(store: PluginStore, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  const isList = path === '' || path === '/'
  if (!isList && !COMMANDS.has(path)) {
    send(res, 404, { error: `no route for ${method} ${ROUTE_PREFIX}${path}` })
    return
  }
  if (!isList && method !== 'POST') {
    send(res, 405, { error: `${method} is not supported here; use POST` })
    return
  }
  if (isList) {
    if (method !== 'GET') {
      send(res, 405, { error: `${method} is not supported here; use GET` })
      return
    }
    const payload: ListPayload = { directory: store.root, plugins: store.list() }
    send(res, 200, payload)
    return
  }
  const body = await readBody(req)
  switch (path) {
    case '/install': {
      const plugin = body['url'] === undefined
        ? await store.installFromFile(stringArgument(body, 'path'))
        : await store.installFromUrl(stringArgument(body, 'url'))
      send(res, 200, { plugin })
      return
    }
    case '/uninstall': {
      await store.uninstall(stringArgument(body, 'id'))
      send(res, 200, { ok: true })
      return
    }
    default: {
      const enabled = body['enabled']
      if (typeof enabled !== 'boolean') throw new PluginError('io-failed', '"enabled" must be a boolean')
      send(res, 200, { plugin: await store.setEnabled(stringArgument(body, 'id'), enabled) })
    }
  }
}
