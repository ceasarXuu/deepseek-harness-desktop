/**
 * The store end to end: a bundle goes in, its server runs as its own process,
 * its tool answers a real call, and removing it takes the tool, the process,
 * and the bytes away.
 *
 * The fixture server is dependency-free, so a passing case exercises the whole
 * path — manifest validation, extraction, spawn planning, the mounted
 * `mcp-client` instance, and a call across the process boundary — with nothing
 * but what a published bundle carries.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PluginError, toServerName } from '@deepseek-ai/dsh-desktop-plugin-store/src/manifest.ts'
import { PluginStore } from '@deepseek-ai/dsh-desktop-plugin-store/src/store.ts'
import { fixtureServerPath, makeBundle, packInstalledPackage } from './support/bundles.ts'

const signal = new AbortController().signal

let directory: string
let ctx: Context
let store: PluginStore

/** Mount the two services `mcp-client` and the tool registry need. */
async function createContext(): Promise<Context> {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  return context
}

/** A bundle carrying the dependency-free fixture server. */
function fixtureBundle(overrides: Record<string, unknown> = {}): Uint8Array {
  return makeBundle({
    manifest_version: '0.3',
    name: 'echo-fixture',
    display_name: 'Echo Fixture',
    version: '1.0.0',
    description: 'A dependency-free MCP server used by the store tests.',
    author: { name: 'Tester' },
    server: {
      type: 'node',
      entry_point: 'server.mjs',
      mcp_config: { command: 'node', args: ['${__dirname}/server.mjs'] },
    },
    ...overrides,
  }, [{ name: 'server.mjs', content: new Uint8Array(readFileSync(fixtureServerPath())) }])
}

/** Write a bundle to a file the store can install from. */
function writeBundle(bytes: Uint8Array, name = 'plugin.mcpb'): string {
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

/** The model-facing name of one fixture tool. */
function toolName(id: string, tool: string): string {
  return `mcp__${toServerName(id)}__${tool}`
}

/** Call one tool through the registry, the way the agent loop does. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.tools.execute({ signal, callId: CallId(`test-${name}`), name, arguments: args })
  expect(result.isError).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error(`expected text, got ${JSON.stringify(block)}`)
  return block.text
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-plugin-store-'))
  ctx = await createContext()
  store = new PluginStore(ctx, { directory, runtime: process.execPath })
  await store.start()
})

afterEach(async () => {
  await store.dispose()
  await ctx.fiber.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('installing a bundle', () => {
  it('mounts the server, registers its tools, and answers a real call', async () => {
    const plugin = await store.installFromFile(writeBundle(fixtureBundle()))

    expect(plugin.state).toBe('mounted')
    expect(plugin.displayName).toBe('Echo Fixture')
    expect(plugin.tools).toEqual([toolName('echo-fixture', 'echo'), toolName('echo-fixture', 'sum')])
    expect(await callTool(toolName('echo-fixture', 'echo'), { text: 'hello' })).toBe('echo: hello')
    expect(await callTool(toolName('echo-fixture', 'sum'), { a: 2, b: 3 })).toBe('5')
  })

  it('writes the plugin under its own directory and records it', async () => {
    await store.installFromFile(writeBundle(fixtureBundle()))
    expect(existsSync(join(directory, 'echo-fixture', '1.0.0', 'server.mjs'))).toBe(true)
    const registry = JSON.parse(readFileSync(join(directory, 'installed.json'), 'utf8')) as {
      version: number
      plugins: { id: string; version: string; enabled: boolean; serverName: string }[]
    }
    expect(registry.version).toBe(1)
    expect(registry.plugins).toHaveLength(1)
    expect(registry.plugins[0]).toMatchObject({ id: 'echo-fixture', version: '1.0.0', enabled: true })
    expect(registry.plugins[0]?.serverName).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('keeps a disabled plugin disabled across an upgrade', async () => {
    const first = await store.installFromFile(writeBundle(fixtureBundle()))
    await store.setEnabled(first.id, false)
    const upgraded = await store.installFromFile(writeBundle(fixtureBundle({ version: '1.1.0' }), 'upgrade.mcpb'))
    expect(upgraded).toMatchObject({ version: '1.1.0', enabled: false, state: 'disabled' })
    expect(existsSync(join(directory, 'echo-fixture', '1.0.0'))).toBe(false)
  })
})

describe('enable, disable, and uninstall', () => {
  it('takes the tools away when disabled and brings them back when enabled', async () => {
    const plugin = await store.installFromFile(writeBundle(fixtureBundle()))
    const name = toolName('echo-fixture', 'echo')

    expect(await store.setEnabled(plugin.id, false)).toMatchObject({ state: 'disabled', tools: [] })
    expect(ctx.tools.get(name)).toBeUndefined()

    expect(await store.setEnabled(plugin.id, true)).toMatchObject({ state: 'mounted' })
    expect(await callTool(name, { text: 'back' })).toBe('echo: back')
  })

  it('removes the tools, the bytes, and the record on uninstall', async () => {
    const plugin = await store.installFromFile(writeBundle(fixtureBundle()))
    await store.uninstall(plugin.id)

    expect(store.list()).toEqual([])
    expect(ctx.tools.get(toolName('echo-fixture', 'echo'))).toBeUndefined()
    expect(existsSync(join(directory, 'echo-fixture'))).toBe(false)
  })

  it('refuses to uninstall something that is not installed', async () => {
    await expect(store.uninstall('missing')).rejects.toThrow(PluginError)
  })

  it('refuses to enable something that is not installed', async () => {
    await expect(store.setEnabled('missing', true)).rejects.toThrow(/no plugin installed/)
  })
})

describe('a plugin that cannot start', () => {
  it('is recorded as failed, keeps the host working, and stays removable', async () => {
    const broken = makeBundle({
      manifest_version: '0.3',
      name: 'broken-plugin',
      version: '1.0.0',
      description: 'Exits immediately.',
      author: { name: 'Tester' },
      server: { type: 'node', entry_point: 'server.js', mcp_config: { command: 'node', args: ['${__dirname}/server.js'] } },
    }, [{ name: 'server.js', content: 'process.exit(3)\n' }])

    const plugin = await store.installFromFile(writeBundle(broken, 'broken.mcpb'))
    expect(plugin.state).toBe('failed')
    expect(plugin.detail).toBeTruthy()

    const healthy = await store.installFromFile(writeBundle(fixtureBundle(), 'healthy.mcpb'))
    expect(healthy.state).toBe('mounted')
    expect(await callTool(toolName('echo-fixture', 'echo'), { text: 'still here' })).toBe('echo: still here')

    await store.uninstall(plugin.id)
    expect(store.list().map(entry => entry.id)).toEqual(['echo-fixture'])
  })

  it('refuses a bundle whose entry point is absent before anything is written', async () => {
    const missing = makeBundle({
      manifest_version: '0.3',
      name: 'missing-entry',
      version: '1.0.0',
      description: 'Declares an entry it does not carry.',
      author: { name: 'Tester' },
      server: { type: 'node', entry_point: 'nope.js', mcp_config: { command: 'node', args: ['${__dirname}/nope.js'] } },
    }, [{ name: 'other.js', content: '1\n' }])

    await expect(store.installFromFile(writeBundle(missing, 'missing.mcpb'))).rejects.toThrow(/entry point/)
    expect(existsSync(join(directory, 'missing-entry'))).toBe(false)
  })
})

describe('an external plugin', () => {
  const packageDirectory = join(
    new URL('../../../../packages/mcp/mcp-client', import.meta.url).pathname,
    'node_modules/@modelcontextprotocol/server-everything',
  )

  it('installs a real published MCP server, packed with its own dependencies', async () => {
    const packageManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      version?: string
      bin?: Record<string, string>
    }
    const bin = Object.values(packageManifest.bin ?? {})[0]
    if (bin === undefined) throw new Error('the external package declares no bin entry')

    const bytes = packInstalledPackage(packageDirectory, bin, ['stdio'])
    expect(bytes).toBeDefined()

    const plugin = await store.installFromFile(writeBundle(bytes!, 'everything.mcpb'))
    expect(plugin.state, plugin.detail).toBe('mounted')
    expect(plugin.tools.length).toBeGreaterThan(3)
    expect(plugin.tools.every(name => name.startsWith(`mcp__${toServerName(plugin.id)}__`))).toBe(true)

    const echo = plugin.tools.find(name => name.endsWith('__echo'))
    expect(echo).toBeDefined()
    expect(await callTool(echo!, { message: 'external' })).toContain('external')
  }, 120_000)
})
