/**
 * The route surface the Plugins panel talks to. These cases drive it over real
 * HTTP against the composition's own webserver, so what the panel can do — and
 * what it is refused — is pinned at the boundary a browser reaches.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ROUTE_PREFIX, apply } from '@deepseek-ai/dsh-desktop-plugin-store/src/index.ts'
import { fixtureServerPath, makeBundle } from './support/bundles.ts'

/** The bundle the route cases install, shaped like the store's other fixture. */
const BUNDLE = makeBundle({
  manifest_version: '0.3',
  name: 'route-fixture',
  version: '1.0.0',
  description: 'A dependency-free MCP server used by the route tests.',
  author: { name: 'Tester' },
  server: { type: 'node', entry_point: 'server.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server.mjs'] } },
}, [{ name: 'server.mjs', content: new Uint8Array(readFileSync(fixtureServerPath())) }])

let directory: string
let ctx: Context
let base: string

/** Call one route and decode its JSON answer. */
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${ROUTE_PREFIX}${path}`, init)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** POST a JSON body to one route. */
async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return await call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The installed plugin list the panel reads. */
async function listed(): Promise<{ id: string; state: string }[]> {
  const { body } = await call('')
  return body['plugins'] as { id: string; state: string }[]
}

/** Write the fixture bundle into the temporary directory. */
function bundleFile(): string {
  const path = join(directory, 'route.mcpb')
  writeFileSync(path, BUNDLE)
  return path
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-plugin-routes-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ apply }, { directory })
  base = `http://127.0.0.1:${String(ctx.get('webServer')?.port)}`
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('the plugin routes', () => {
  it('lists nothing before anything is installed', async () => {
    const { status, body } = await call('')
    expect(status).toBe(200)
    expect(body['plugins']).toEqual([])
    expect(body['directory']).toBe(directory)
  })

  it('installs from a file path and reports the mounted plugin', async () => {
    const { status, body } = await post('/install', { path: bundleFile() })
    expect(status).toBe(200)
    expect(body['plugin']).toMatchObject({ id: 'route-fixture', state: 'mounted' })
    expect(await listed()).toMatchObject([{ id: 'route-fixture', state: 'mounted' }])
  })

  it('disables and re-enables an installed plugin', async () => {
    await post('/install', { path: bundleFile() })
    expect((await post('/set-enabled', { id: 'route-fixture', enabled: false })).body['plugin'])
      .toMatchObject({ state: 'disabled' })
    expect(await listed()).toMatchObject([{ id: 'route-fixture', state: 'disabled' }])
    expect((await post('/set-enabled', { id: 'route-fixture', enabled: true })).body['plugin'])
      .toMatchObject({ state: 'mounted' })
  })

  it('uninstalls, leaving nothing listed', async () => {
    await post('/install', { path: bundleFile() })
    expect((await post('/uninstall', { id: 'route-fixture' })).body).toEqual({ ok: true })
    expect(await listed()).toEqual([])
  })

  it('answers an unknown route with 404 and an unsupported method with 405', async () => {
    expect((await call('/nope')).status).toBe(404)
    expect((await call('')).status).toBe(200)
    const response = await fetch(`${base}${ROUTE_PREFIX}/install`, { method: 'DELETE' })
    expect(response.status).toBe(405)
  })

  it('reports a refusal as its own code and message', async () => {
    const { status, body } = await post('/install', { path: join(directory, 'absent.mcpb') })
    expect(status).toBe(404)
    expect(body['code']).toBe('not-found')
    expect(String(body['error'])).toContain('absent.mcpb')
  })

  it('refuses a POST whose body is not a JSON object', async () => {
    const response = await fetch(`${base}${ROUTE_PREFIX}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"nope"',
    })
    expect(response.status).toBe(502)
  })

  it('refuses a request that does not name the plugin', async () => {
    const { status, body } = await post('/uninstall', {})
    expect(status).toBe(502)
    expect(String(body['error'])).toContain('id')
  })
})
