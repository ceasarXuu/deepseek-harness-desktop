/**
 * Installing an MCP bundle is the one path where an archive a user picked
 * reaches the filesystem, so these cases cover what a well-formed bundle does,
 * the shapes a hostile one takes, and the two halves every install produces:
 * the payload under the plugin directory and the generated desktop plugin the
 * profile manager mounts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRY_PATH,
  MCP_CLIENT_PACKAGE,
  McpBundleError,
  McpBundleStore,
  bundlePluginPackageName,
  bundlePluginSpec,
  checkPlatformCompatibility,
  downloadBundle,
  isSafeEntryName,
  openBundle,
  parseBundleManifest,
  planBundleServer,
  substituteVariables,
  toPluginId,
  toServerName,
} from '../src/mcp-bundles.ts'
import {
  FIXTURE_ENTRY,
  archiveFromManifestText,
  bundleManifest,
  echoBundle,
  fixtureServerSource,
  makeBundle,
} from './support/bundles.ts'

const variables = { dirname: '/plugins/demo/1.0.0', home: '/Users/tester' }

let root: string
let store: McpBundleStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mcp-bundle-'))
  store = new McpBundleStore({
    pluginsDir: join(root, 'plugins'),
    profileDir: join(root, 'profile'),
    nodeRuntime: join(root, 'app', 'node'),
    peerPackages: { [MCP_CLIENT_PACKAGE]: '0.1.5-rc.2' },
    platform: 'darwin',
    home: '/Users/tester',
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The generated plugin's manifest, as the profile manager would read it. */
function generatedManifest(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'profile', 'plugins', id, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** The generated patch's parsed entries. */
function generatedPatch(id: string): { insert: { id: string; name: string; config: Record<string, unknown> }[] }[] {
  const text = readFileSync(join(root, 'profile', 'plugins', id, 'cordis.patch.yml'), 'utf8')
  return yaml.load(text) as { insert: { id: string; name: string; config: Record<string, unknown> }[] }[]
}

/** The registry file's parsed contents. */
function registry(): { version: number; bundles: { id: string; version: string; enabled: boolean; serverName: string }[] } {
  const text = readFileSync(join(root, 'plugins', 'installed.json'), 'utf8')
  return JSON.parse(text) as { version: number; bundles: { id: string; version: string; enabled: boolean; serverName: string }[] }
}

/** Serve one archive over loopback so a URL install has something to reach. */
async function serveArchive(bytes: Uint8Array): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => { response.end(bytes) })
  await new Promise<void>((settle, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', settle) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((settle) => { server.close(() => { settle() }) }),
  }
}

describe('entry names', () => {
  it('accepts ordinary relative paths, including nested ones', () => {
    expect(isSafeEntryName('manifest.json')).toBe(true)
    expect(isSafeEntryName('server/lib/deep/file.js')).toBe(true)
  })

  it.each([
    ['absolute', '/etc/passwd'],
    ['traversing', '../../etc/passwd'],
    ['traversing mid-path', 'server/../../outside.js'],
    ['windows separator', 'server\\file.js'],
    ['empty', ''],
    ['over-long', `${'a'.repeat(MAX_ENTRY_PATH)}.js`],
  ])('refuses a %s name', (_case, name) => {
    expect(isSafeEntryName(name)).toBe(false)
  })
})

describe('opening an archive', () => {
  it('returns the entries and the manifest text', () => {
    const archive = openBundle(makeBundle(bundleManifest(), [{ name: FIXTURE_ENTRY, content: 'x' }]))
    expect(archive.entries.size).toBe(2)
    expect(JSON.parse(archive.manifest)).toMatchObject({ name: 'demo' })
  })

  it('refuses a file that is not an archive', () => {
    expect(() => openBundle(strToU8('not a zip'))).toThrow(McpBundleError)
  })

  it('refuses an archive with no manifest at its root', () => {
    expect(() => openBundle(zipSync({ 'server/index.js': strToU8('x') }))).toThrow(/manifest\.json/u)
  })

  it('refuses a manifest that is not JSON', () => {
    expect(() => openBundle(archiveFromManifestText('{oops'))).toThrow(/valid JSON/u)
  })

  it('refuses an entry that would land outside the bundle', () => {
    const bytes = zipSync({ 'manifest.json': strToU8('{}'), '../escape.js': strToU8('x') })
    expect(() => openBundle(bytes)).toThrow(/outside the bundle/u)
  })

  it('refuses an archive holding more files than the limit allows', () => {
    const entries: Record<string, Uint8Array> = { 'manifest.json': strToU8('{}') }
    for (let index = 0; index <= 20_000; index += 1) entries[`f/${String(index)}.js`] = strToU8('')
    expect(() => openBundle(zipSync(entries, { level: 0 }))).toThrow(/more than 20000/u)
  })
})

describe('download', () => {
  it('refuses a URL that is not http or https', async () => {
    await expect(downloadBundle('file:///tmp/x.mcpb')).rejects.toThrow(/http/u)
  })

  it('reports an unreachable host rather than a fetch error', async () => {
    await expect(downloadBundle('http://127.0.0.1:1/none.mcpb')).rejects.toThrow(McpBundleError)
  })
})

describe('bundle identity', () => {
  it('normalizes a manifest name into an install id', () => {
    expect(toPluginId('My Fancy Bundle')).toBe('my-fancy-bundle')
    expect(toPluginId('@scope/name')).toBe('scope-name')
  })

  it('refuses a name that yields no usable id', () => {
    expect(() => toPluginId('***')).toThrow(McpBundleError)
  })

  it('derives a server namespace that fits the tool-name contract and stays distinct', () => {
    const first = toServerName(`${'a'.repeat(40)}-one`)
    const second = toServerName(`${'a'.repeat(40)}-two`)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/u)
    expect(first).not.toBe(second)
    expect(toServerName('demo')).toBe(toServerName('demo'))
  })

  it('names the generated plugin and the profile spec after the bundle id', () => {
    expect(bundlePluginPackageName('demo')).toBe('dsh-mcp-bundle-demo')
    expect(bundlePluginSpec('demo')).toBe('file:./plugins/demo')
  })
})

describe('variable substitution', () => {
  it('replaces the paths the specification defines', () => {
    expect(substituteVariables('${__dirname}/a', variables)).toBe('/plugins/demo/1.0.0/a')
    expect(substituteVariables('${HOME}/b', variables)).toBe('/Users/tester/b')
    expect(substituteVariables('${DOCUMENTS}', variables)).toBe('/Users/tester/Documents')
    expect(substituteVariables('a${pathSeparator}b', variables)).toBe('a/b')
  })

  it('leaves a placeholder it does not own untouched rather than emptying it', () => {
    expect(substituteVariables('${SOMETHING_ELSE}', variables)).toBe('${SOMETHING_ELSE}')
  })
})

describe('manifest validation', () => {
  it('resolves a valid manifest', () => {
    expect(parseBundleManifest(bundleManifest(), variables, 'darwin')).toMatchObject({
      id: 'demo',
      displayName: 'demo',
      version: '1.0.0',
      description: 'A bundle used by the tests.',
      author: 'Tester',
      serverType: 'node',
      entryPoint: FIXTURE_ENTRY,
    })
  })

  it('prefers the display name when the manifest declares one', () => {
    expect(parseBundleManifest(bundleManifest({ display_name: 'Demo' }), variables, 'darwin').displayName).toBe('Demo')
  })

  it.each([
    ['manifest_version', { manifest_version: undefined }],
    ['name', { name: undefined }],
    ['version', { version: undefined }],
    ['description', { description: '' }],
    ['author', { author: undefined }],
  ])('refuses a manifest without %s', (field, override) => {
    try {
      parseBundleManifest(bundleManifest(override), variables, 'darwin')
      expect.unreachable(`a manifest without ${field} was accepted`)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(McpBundleError)
      expect((error as McpBundleError).message).toContain(field)
    }
  })

  it('refuses a server kind this application cannot run, with a stable code', () => {
    const raw = bundleManifest({ server: { type: 'python', entry_point: 'server/main.py' } })
    try {
      parseBundleManifest(raw, variables, 'darwin')
      expect.unreachable('a python bundle was accepted')
    } catch (error: unknown) {
      expect((error as McpBundleError).code).toBe('server-unsupported')
      expect((error as McpBundleError).message).toMatch(/node.*binary.*python/su)
    }
  })

  it.each([
    ['absolute', '/etc/passwd'],
    ['traversing', '../../etc/passwd'],
    ['windows separator', 'server\\index.js'],
  ])('refuses an entry point that leaves the bundle (%s)', (_case, entryPoint) => {
    const raw = bundleManifest({ server: { type: 'node', entry_point: entryPoint } })
    expect(() => parseBundleManifest(raw, variables, 'darwin')).toThrow(/entry_point/u)
  })

  it('refuses a bundle that declares user configuration, naming the keys', () => {
    const raw = bundleManifest({ user_config: { api_key: { type: 'string' } } })
    try {
      parseBundleManifest(raw, variables, 'darwin')
      expect.unreachable('a bundle needing configuration was accepted')
    } catch (error: unknown) {
      expect((error as McpBundleError).code).toBe('user-config-required')
      expect((error as McpBundleError).message).toContain('api_key')
    }
  })

  it('refuses a bundle whose launch arguments reference user configuration', () => {
    const raw = bundleManifest({
      server: {
        type: 'node',
        entry_point: FIXTURE_ENTRY,
        mcp_config: { command: 'node', args: ['${__dirname}/${entry}'], env: { KEY: '${user_config.api_key}' } },
      },
    })
    expect(() => parseBundleManifest(raw, variables, 'darwin')).toThrow(/api_key/u)
  })

  it('applies a platform override for the running platform', () => {
    const raw = bundleManifest({
      server: {
        type: 'node',
        entry_point: FIXTURE_ENTRY,
        mcp_config: {
          command: 'node',
          args: ['server/index.js'],
          platform_overrides: { darwin: { args: ['${__dirname}/server/mac.js'] } },
        },
      },
    })
    expect(parseBundleManifest(raw, variables, 'darwin').args).toEqual(['/plugins/demo/1.0.0/server/mac.js'])
    expect(parseBundleManifest(raw, variables, 'linux').args).toEqual(['server/index.js'])
  })

  it('carries the declared compatibility through for display', () => {
    const raw = bundleManifest({ compatibility: { platforms: ['darwin'], runtimes: { node: '>=20' }, dsh: '>=0.0.2' } })
    const resolved = parseBundleManifest(raw, variables, 'darwin')
    expect(resolved.platforms).toEqual(['darwin'])
    expect(resolved.nodeRange).toBe('>=20')
    expect(resolved.appRange).toBe('>=0.0.2')
  })
})

describe('server launch plan', () => {
  let directory: string

  beforeEach(() => {
    directory = join(root, 'installed', '1.0.0')
    mkdirSync(join(directory, 'server'), { recursive: true })
    writeFileSync(join(directory, FIXTURE_ENTRY), '')
    writeFileSync(join(directory, 'serve.js'), '')
    mkdirSync(join(directory, 'bin'), { recursive: true })
    writeFileSync(join(directory, 'bin', 'server'), '', { mode: 0o755 })
  })

  it('re-enters the application binary as Node for a node server', () => {
    const manifest = parseBundleManifest(bundleManifest(), { dirname: directory, home: '/Users/tester' }, 'darwin')
    expect(planBundleServer(manifest, { directory, runtime: '/app/node' })).toEqual({
      command: '/app/node',
      args: [join(directory, FIXTURE_ENTRY)],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      cwd: directory,
    })
  })

  it('carries declared argv through in place of the entry point', () => {
    const raw = bundleManifest({
      server: {
        type: 'node',
        entry_point: FIXTURE_ENTRY,
        mcp_config: { command: 'node', args: ['${__dirname}/serve.js', 'serve'] },
      },
    })
    const manifest = parseBundleManifest(raw, { dirname: directory, home: '/Users/tester' }, 'darwin')
    expect(planBundleServer(manifest, { directory, runtime: '/app/node' }).args).toEqual([join(directory, 'serve.js'), 'serve'])
  })

  it('runs a binary server from the bundle itself', () => {
    const raw = bundleManifest({ server: { type: 'binary', entry_point: 'bin/server' } })
    const manifest = parseBundleManifest(raw, { dirname: directory, home: '/Users/tester' }, 'darwin')
    expect(planBundleServer(manifest, { directory, runtime: '/app/node' })).toMatchObject({
      command: join(directory, 'bin', 'server'),
      env: {},
    })
  })

  it('refuses an entry point the installed directory does not hold', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const manifest = parseBundleManifest(bundleManifest(), { dirname: empty, home: '/Users/tester' }, 'darwin')
    expect(() => planBundleServer(manifest, { directory: empty, runtime: '/app/node' }))
      .toThrow(/missing its entry point/u)
  })
})

describe('platform compatibility', () => {
  it('refuses a bundle that does not list this platform, naming it', () => {
    const resolved = parseBundleManifest(bundleManifest({ compatibility: { platforms: ['win32'] } }), variables, 'darwin')
    expect(() => { checkPlatformCompatibility(resolved, 'darwin') }).toThrow(/win32/u)
    expect(() => { checkPlatformCompatibility(resolved, 'win32') }).not.toThrow()
  })

  it('accepts a bundle with no declared platform', () => {
    const resolved = parseBundleManifest(bundleManifest(), variables, 'darwin')
    expect(resolved.platforms).toEqual([])
    expect(() => { checkPlatformCompatibility(resolved, 'darwin') }).not.toThrow()
  })
})

describe('installing a bundle', () => {
  it('writes the payload, the generated plugin, and the registry record', async () => {
    const path = join(root, 'demo.mcpb')
    writeFileSync(path, echoBundle())
    const record = await store.installFromFile(path)

    expect(record).toMatchObject({
      id: 'demo',
      name: 'dsh-mcp-bundle-demo',
      spec: 'file:./plugins/demo',
      version: '1.0.0',
      enabled: true,
      displayName: 'demo',
      description: 'A bundle used by the tests.',
      author: 'Tester',
      source: { kind: 'file', value: path },
      platforms: [],
      tools: [],
    })
    expect(record.serverName).toMatch(/^[A-Za-z0-9_-]{1,32}$/u)

    // The payload is the archive's own contents, beside the registry record.
    const payload = join(root, 'plugins', 'demo', '1.0.0')
    expect(readFileSync(join(payload, FIXTURE_ENTRY), 'utf8')).toBe(fixtureServerSource())
    expect(existsSync(join(payload, 'manifest.json'))).toBe(true)
    expect(registry().bundles.map(bundle => bundle.id)).toEqual(['demo'])

    // The generated plugin is what the profile records and the loader mounts.
    expect(generatedManifest('demo')).toEqual({
      name: 'dsh-mcp-bundle-demo',
      version: '1.0.0',
      private: true,
      type: 'module',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { [MCP_CLIENT_PACKAGE]: '0.1.5-rc.2' },
    })
    const patches = generatedPatch('demo')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.insert).toEqual([{
      id: `mcp-bundle-${record.serverName}`,
      name: MCP_CLIENT_PACKAGE,
      config: {
        transport: 'stdio',
        serverName: record.serverName,
        command: join(root, 'app', 'node'),
        args: [join(payload, FIXTURE_ENTRY)],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        cwd: payload,
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
    }])
  })

  it('declares no peer the running host does not carry', async () => {
    const bare = new McpBundleStore({
      pluginsDir: join(root, 'plugins'),
      profileDir: join(root, 'profile'),
      nodeRuntime: join(root, 'app', 'node'),
      peerPackages: {},
      platform: 'darwin',
      home: '/Users/tester',
    })
    const path = join(root, 'demo.mcpb')
    writeFileSync(path, echoBundle())
    await bare.installFromFile(path)
    expect(generatedManifest('demo')['peerDependencies']).toEqual({ [MCP_CLIENT_PACKAGE]: '*' })
  })

  it('keeps the enabled state and the server namespace across an upgrade, and prunes the old version', async () => {
    const first = join(root, 'demo-1.mcpb')
    writeFileSync(first, echoBundle())
    const installed = await store.installFromFile(first)
    await store.setEnabled('demo', false)

    const second = join(root, 'demo-2.mcpb')
    writeFileSync(second, echoBundle({ version: '2.0.0' }))
    const upgraded = await store.installFromFile(second)

    expect(upgraded).toMatchObject({ version: '2.0.0', enabled: false, serverName: installed.serverName })
    expect(readdirSync(join(root, 'plugins', 'demo'))).toEqual(['2.0.0'])
    expect(generatedManifest('demo')['version']).toBe('2.0.0')
    expect(registry().bundles).toHaveLength(1)
    expect(registry().bundles[0]?.version).toBe('2.0.0')
  })

  it('refuses a bundle whose entry point the archive does not carry, leaving nothing behind', async () => {
    const path = join(root, 'broken.mcpb')
    writeFileSync(path, makeBundle(bundleManifest()))
    await expect(store.installFromFile(path)).rejects.toThrow(/missing its entry point/u)
    expect(existsSync(join(root, 'plugins', 'demo'))).toBe(false)
    expect(existsSync(join(root, 'profile', 'plugins', 'demo'))).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('refuses a bundle this platform cannot run', async () => {
    const path = join(root, 'windows.mcpb')
    writeFileSync(path, echoBundle({ compatibility: { platforms: ['win32'] } }))
    await expect(store.installFromFile(path)).rejects.toThrow(/win32/u)
    expect(store.list()).toEqual([])
  })

  it('refuses a file that is not there', async () => {
    await expect(store.installFromFile(join(root, 'absent.mcpb'))).rejects.toThrow(McpBundleError)
  })

  it('installs from a URL', async () => {
    const fixture = await serveArchive(echoBundle())
    try {
      const url = `${fixture.origin}/demo.mcpb`
      expect(await store.installFromUrl(url)).toMatchObject({ id: 'demo', enabled: true, source: { kind: 'url', value: url } })
      expect(existsSync(join(root, 'plugins', 'demo', '1.0.0', FIXTURE_ENTRY))).toBe(true)
    } finally {
      await fixture.close()
    }
  })
})

describe('managing installed bundles', () => {
  it('lists, disables, re-enables, and removes one bundle', async () => {
    const path = join(root, 'demo.mcpb')
    writeFileSync(path, echoBundle())
    await store.installFromFile(path)

    expect(store.list().map(bundle => bundle.enabled)).toEqual([true])
    expect((await store.setEnabled('demo', false)).enabled).toBe(false)
    expect(store.list().map(bundle => bundle.enabled)).toEqual([false])
    expect((await store.setEnabled('demo', true)).enabled).toBe(true)

    await store.remove('demo')
    expect(store.list()).toEqual([])
    expect(existsSync(join(root, 'plugins', 'demo'))).toBe(false)
    expect(existsSync(join(root, 'profile', 'plugins', 'demo'))).toBe(false)
    expect(registry().bundles).toEqual([])
  })

  it('refuses to manage a bundle that is not installed', async () => {
    await expect(store.setEnabled('absent', true)).rejects.toThrow(McpBundleError)
    await expect(store.remove('absent')).rejects.toThrow(McpBundleError)
  })

  it('reads an empty registry from a directory that has none', () => {
    expect(store.list()).toEqual([])
    expect(store.root).toBe(join(root, 'plugins'))
    expect(store.pluginDirectory('demo')).toBe(join(root, 'profile', 'plugins', 'demo'))
  })
})
