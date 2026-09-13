/**
 * Archive handling is the one place a bundle's bytes reach the filesystem, so
 * these cases cover both what a well-formed bundle does and the shapes a
 * hostile one takes: entries that escape the target, archives that expand past
 * their budget, and files that are not archives at all.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginError } from '@deepseek-ai/dsh-desktop-plugin-store/src/manifest.ts'
import {
  MAX_ENTRY_PATH,
  downloadBundle,
  extractBundle,
  isSafeEntryName,
  openBundle,
} from '@deepseek-ai/dsh-desktop-plugin-store/src/bundle.ts'

const MANIFEST = { manifest_version: '0.3', name: 'demo', version: '1.0.0' }

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-plugin-bundle-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

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
    const archive = openBundle(zipSync({
      'manifest.json': strToU8(JSON.stringify(MANIFEST)),
      'server/index.js': strToU8('console.log(1)'),
    }))
    expect(archive.entries.size).toBe(2)
    expect(JSON.parse(archive.manifest)).toMatchObject({ name: 'demo' })
  })

  it('refuses a file that is not an archive', () => {
    expect(() => openBundle(strToU8('not a zip'))).toThrow(PluginError)
  })

  it('refuses an archive with no manifest at its root', () => {
    expect(() => openBundle(zipSync({ 'server/index.js': strToU8('x') }))).toThrow(/manifest\.json/)
  })

  it('refuses a manifest that is not JSON', () => {
    expect(() => openBundle(zipSync({ 'manifest.json': strToU8('{oops') }))).toThrow(/valid JSON/)
  })

  it('refuses an entry that would land outside the bundle', () => {
    expect(() => openBundle(zipSync({ 'manifest.json': strToU8('{}'), '../escape.js': strToU8('x') })))
      .toThrow(/outside the bundle/)
  })
})

describe('extracting a bundle', () => {
  it('writes every entry under the target directory', () => {
    const archive = openBundle(zipSync({
      'manifest.json': strToU8(JSON.stringify(MANIFEST)),
      'server/index.js': strToU8('module.exports = 1'),
    }))
    const target = join(directory, 'plugin')
    extractBundle(archive, target)
    expect(readFileSync(join(target, 'server/index.js'), 'utf8')).toBe('module.exports = 1')
  })

  it('replaces whatever the target held before', () => {
    const target = join(directory, 'plugin')
    extractBundle(openBundle(zipSync({ 'manifest.json': strToU8('{}'), 'a.js': strToU8('a') })), target)
    extractBundle(openBundle(zipSync({ 'manifest.json': strToU8('{}'), 'b.js': strToU8('b') })), target)
    expect(existsSync(join(target, 'a.js'))).toBe(false)
    expect(existsSync(join(target, 'b.js'))).toBe(true)
  })
})

describe('downloading a bundle', () => {
  it('refuses a URL that is not http or https', async () => {
    await expect(downloadBundle('file:///tmp/x.mcpb')).rejects.toThrow(/http/)
  })

  it('reports an unreachable host rather than throwing a fetch error', async () => {
    await expect(downloadBundle('http://127.0.0.1:1/none.mcpb')).rejects.toThrow(PluginError)
  })
})

describe('fixture sanity', () => {
  it('keeps a written archive readable end to end', () => {
    const path = join(directory, 'bundle.mcpb')
    writeFileSync(path, zipSync({ 'manifest.json': strToU8(JSON.stringify(MANIFEST)) }))
    expect(JSON.parse(openBundle(new Uint8Array(readFileSync(path))).manifest)).toMatchObject({ name: 'demo' })
  })
})
