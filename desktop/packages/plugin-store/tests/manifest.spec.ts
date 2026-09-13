/**
 * Manifest validation is the store's only gate on untrusted input: a bundle's
 * manifest decides what process gets launched and with what. These cases pin
 * what is accepted, what is refused, and that a refusal says why.
 */

import { describe, expect, it } from 'vitest'
import {
  PluginError,
  checkPlatformCompatibility,
  parseManifest,
  referencedUserConfig,
  substituteVariables,
  toPluginId,
  toServerName,
} from '@deepseek-ai/dsh-desktop-plugin-store/src/manifest.ts'

const variables = { dirname: '/plugins/demo/1.0.0', home: '/Users/tester' }

/** A minimal valid manifest, with per-case overrides applied on top. */
function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    manifest_version: '0.3',
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'A plugin used by the tests.',
    author: { name: 'Tester' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
    },
    ...overrides,
  }
}

describe('plugin identity', () => {
  it('normalizes a manifest name into an install id', () => {
    expect(toPluginId('My Fancy Plugin')).toBe('my-fancy-plugin')
    expect(toPluginId('@scope/name')).toBe('scope-name')
  })

  it('refuses a name that yields no usable id', () => {
    expect(() => toPluginId('***')).toThrow(PluginError)
  })

  it('derives a server namespace that fits the tool-name contract and stays distinct', () => {
    const first = toServerName('a'.repeat(40) + '-one')
    const second = toServerName('a'.repeat(40) + '-two')
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(first).not.toBe(second)
    expect(toServerName('demo')).toBe(toServerName('demo'))
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
    const resolved = parseManifest(manifest(), variables, 'darwin')
    expect(resolved).toMatchObject({
      id: 'demo-plugin',
      displayName: 'demo-plugin',
      version: '1.0.0',
      serverType: 'node',
      entryPoint: 'server/index.js',
      author: 'Tester',
    })
    expect(resolved.args).toEqual(['/plugins/demo/1.0.0/server/index.js'])
  })

  it('prefers the display name when the manifest declares one', () => {
    expect(parseManifest(manifest({ display_name: 'Demo' }), variables, 'darwin').displayName).toBe('Demo')
  })

  it.each([
    ['name', { name: undefined }],
    ['version', { version: undefined }],
    ['description', { description: '' }],
    ['author', { author: undefined }],
  ])('refuses a manifest without %s', (field, override) => {
    try {
      parseManifest(manifest(override), variables, 'darwin')
      expect.unreachable(`a manifest without ${field} was accepted`)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as Error).message).toContain(field)
    }
  })

  it('refuses a server kind this application does not run, naming the kind', () => {
    const raw = manifest({ server: { type: 'python', entry_point: 'server/main.py' } })
    expect(() => parseManifest(raw, variables, 'darwin')).toThrow(/node.*binary.*python/s)
  })

  it('refuses an entry point that leaves the bundle', () => {
    const raw = manifest({ server: { type: 'node', entry_point: '../../etc/passwd' } })
    expect(() => parseManifest(raw, variables, 'darwin')).toThrow(PluginError)
  })

  it('refuses a bundle that needs user configuration, naming the keys', () => {
    const raw = manifest({
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { KEY: '${user_config.api_key}' } },
      },
    })
    expect(() => parseManifest(raw, variables, 'darwin')).toThrow(/api_key/)
  })

  it('applies a platform override for the running platform', () => {
    const raw = manifest({
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: {
          command: 'node',
          args: ['server/index.js'],
          platform_overrides: { darwin: { args: ['${__dirname}/server/mac.js'] } },
        },
      },
    })
    expect(parseManifest(raw, variables, 'darwin').args).toEqual(['/plugins/demo/1.0.0/server/mac.js'])
    expect(parseManifest(raw, variables, 'linux').args).toEqual(['server/index.js'])
  })

  it('carries the declared compatibility through for display', () => {
    const raw = manifest({ compatibility: { platforms: ['darwin'], runtimes: { node: '>=20' }, dsh: '>=0.0.2' } })
    const resolved = parseManifest(raw, variables, 'darwin')
    expect(resolved.platforms).toEqual(['darwin'])
    expect(resolved.nodeRange).toBe('>=20')
    expect(resolved.appRange).toBe('>=0.0.2')
  })
})

describe('platform compatibility', () => {
  it('refuses a bundle that does not list this platform', () => {
    const resolved = parseManifest(manifest({ compatibility: { platforms: ['win32'] } }), variables, 'darwin')
    expect(() => checkPlatformCompatibility(resolved, 'darwin')).toThrow(/win32/)
  })

  it('accepts a bundle with no declared platform', () => {
    const resolved = parseManifest(manifest(), variables, 'darwin')
    expect(() => checkPlatformCompatibility(resolved, 'darwin')).not.toThrow()
  })
})

describe('user-config references', () => {
  it('finds referenced keys through args and env', () => {
    expect(referencedUserConfig({
      mcp_config: { args: ['a', '${user_config.one}'], env: { TWO: '${user_config.two}' } },
    })).toEqual(['one', 'two'])
  })

  it('reports nothing for a manifest that references none', () => {
    expect(referencedUserConfig({ mcp_config: { args: ['plain'] } })).toEqual([])
  })
})
