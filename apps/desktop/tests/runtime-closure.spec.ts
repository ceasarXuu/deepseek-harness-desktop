/**
 * The runtime archive's integrity rule: the archive is checked against the digest the signed
 * bundle records, and the expanded tree against the digest recorded when it was written. These
 * cases pin both halves, including what a mismatch does — expanding again rather than starting
 * from a tree nobody vouched for.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_RUNTIME_ARCHIVE,
  DESKTOP_RUNTIME_ARCHIVE_DIGEST,
  DESKTOP_RUNTIME_MARKER,
  ensureDesktopRuntime,
  fileDigest,
  packRuntimeArchive,
  treeDigest,
  verifyRuntimeArchive,
  type DesktopRuntimeArchiveRecord,
  type DesktopRuntimeProgress,
} from '../src/runtime-closure.ts'

let root: string
let tree: string
let archive: string
let home: string

/** Write the small tree the archive will hold. */
function writeTree(): void {
  mkdirSync(join(tree, 'node_modules/demo/lib'), { recursive: true })
  writeFileSync(join(tree, 'node_modules/demo/package.json'), '{"name":"demo"}\n')
  writeFileSync(join(tree, 'node_modules/demo/lib/index.js'), 'export const value = 1\n')
  writeFileSync(join(tree, 'README.md'), '# fixture\n')
}

/** Pack the tree into the archive the application carries, with its digest beside it. */
async function pack(): Promise<DesktopRuntimeArchiveRecord> {
  const record = await packRuntimeArchive(tree, archive)
  expect(readFileSync(`${archive}.sha256`, 'utf8').trim()).toBe(`${record.archiveSha256}  ${String(record.entries)}`)
  return record
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-runtime-closure-'))
  tree = join(root, 'tree')
  archive = join(root, DESKTOP_RUNTIME_ARCHIVE)
  home = join(root, 'closure')
  mkdirSync(tree, { recursive: true })
  writeTree()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('expanding the runtime archive', () => {
  it('expands a verified archive and records both digests', async () => {
    const record = await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    expect(directory).toBe(join(home, '1.0.0'))
    expect(readFileSync(join(directory, 'node_modules/demo/package.json'), 'utf8')).toContain('demo')
    const marker = JSON.parse(readFileSync(join(directory, DESKTOP_RUNTIME_MARKER), 'utf8')) as {
      archiveSha256: string
      archiveBytes: number
      treeSha256: string
      files: number
    }
    expect(marker).toMatchObject({
      archiveSha256: record.archiveSha256,
      archiveBytes: record.bytes,
      treeSha256: record.treeSha256,
      files: record.entries,
    })
  })

  it('does no work when the recorded tree is still the one on disk', async () => {
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    const before = statSync(join(directory, 'README.md')).mtimeMs
    const progress: DesktopRuntimeProgress[] = []
    const again = await ensureDesktopRuntime({ archive, home, version: '1.0.0', onProgress: value => progress.push(value) })
    expect(again).toBe(directory)
    expect(progress).toEqual([{ stage: 'verifying', done: 0, total: 0 }])
    expect(statSync(join(directory, 'README.md')).mtimeMs).toBe(before)
  })

  it('reports the expansion against the entry count the digest records', async () => {
    const record = await pack()
    const progress: DesktopRuntimeProgress[] = []
    await ensureDesktopRuntime({ archive, home, version: '1.0.0', onProgress: value => progress.push(value) })
    expect(progress).toEqual([
      { stage: 'expanding', done: 0, total: record.entries },
      { stage: 'verifying', done: 0, total: 0 },
    ])
  })

  it('restores the executable bit on the binaries the runtime spawns', async () => {
    const ripgrep = join(tree, 'node_modules/@vscode/ripgrep-arm64/bin/rg')
    const spawnHelper = join(tree, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    mkdirSync(dirname(ripgrep), { recursive: true })
    mkdirSync(dirname(spawnHelper), { recursive: true })
    writeFileSync(ripgrep, '#!/bin/sh\n', { mode: 0o644 })
    writeFileSync(spawnHelper, '#!/bin/sh\n', { mode: 0o644 })
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    expect(statSync(join(directory, 'node_modules/@vscode/ripgrep-arm64/bin/rg')).mode & 0o777).toBe(0o755)
    expect(statSync(join(directory, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o755)
    const marker = JSON.parse(readFileSync(join(directory, DESKTOP_RUNTIME_MARKER), 'utf8')) as { restored: string[] }
    expect(marker.restored).toEqual([
      'node_modules/@vscode/ripgrep-arm64/bin/rg',
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    ])
  })

  it('keeps only the version it expanded', async () => {
    await pack()
    const stale = join(home, '0.9.0')
    const interrupted = join(home, '.tmp-interrupted')
    mkdirSync(stale, { recursive: true })
    mkdirSync(interrupted, { recursive: true })
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    expect(statSync(directory).isDirectory()).toBe(true)
    expect(() => statSync(stale)).toThrow()
    expect(() => statSync(interrupted)).toThrow()
  })
})

describe('a runtime that no longer matches', () => {
  it('does not trust a tree whose contents changed, and expands it again', async () => {
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    writeFileSync(join(directory, 'node_modules/demo/lib/index.js'), 'export const value = 666\n')
    const progress: DesktopRuntimeProgress[] = []
    await ensureDesktopRuntime({ archive, home, version: '1.0.0', onProgress: value => progress.push(value) })
    expect(readFileSync(join(directory, 'node_modules/demo/lib/index.js'), 'utf8')).toBe('export const value = 1\n')
    expect(progress.map(value => value.stage)).toEqual(['verifying', 'expanding', 'verifying'])
  })

  it('removes a file added to the tree', async () => {
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    writeFileSync(join(directory, 'node_modules/demo/injected.js'), 'process.exit(1)\n')
    await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    expect(() => readFileSync(join(directory, 'node_modules/demo/injected.js'))).toThrow()
  })

  it('expands again when the recorded marker is unreadable', async () => {
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    writeFileSync(join(directory, DESKTOP_RUNTIME_MARKER), 'not json\n')
    await expect(ensureDesktopRuntime({ archive, home, version: '1.0.0' })).resolves.toBe(directory)
    const marker = JSON.parse(readFileSync(join(directory, DESKTOP_RUNTIME_MARKER), 'utf8')) as { archiveSha256: string }
    expect(marker.archiveSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('refuses an archive that does not match the shipped digest', async () => {
    await pack()
    const content = readFileSync(archive)
    content[content.length - 1] = (content[content.length - 1]! ^ 0xff) & 0xff
    writeFileSync(archive, content)
    await expect(ensureDesktopRuntime({ archive, home, version: '1.0.0' })).rejects.toThrow(/reinstall the application/)
  })

  it('refuses a missing archive', async () => {
    await expect(ensureDesktopRuntime({ archive, home, version: '1.0.0' })).rejects.toThrow(/archive is missing/)
  })

  it('refuses when the shipped digest is absent', async () => {
    await pack()
    rmSync(`${archive}.sha256`)
    await expect(ensureDesktopRuntime({ archive, home, version: '1.0.0' })).rejects.toThrow(/digest is missing/)
    await expect(verifyRuntimeArchive(archive)).rejects.toThrow(/digest is missing/)
  })

  it('refuses when the shipped digest is not a digest', async () => {
    await pack()
    writeFileSync(`${archive}.sha256`, 'not-a-digest\n')
    await expect(ensureDesktopRuntime({ archive, home, version: '1.0.0' })).rejects.toThrow(/not a sha256/)
  })
})

describe('the packed archive', () => {
  it('verifies against the digest it wrote', async () => {
    const record = await pack()
    await expect(verifyRuntimeArchive(archive)).resolves.toBe(record.archiveSha256)
    expect(record.bytes).toBe(statSync(archive).size)
    expect(record.treeSha256).toBe(await treeDigest(tree))
  })

  it('keeps the executable bit the packed tree had', async () => {
    const ripgrep = join(tree, 'node_modules/@vscode/ripgrep-arm64/bin/rg')
    mkdirSync(dirname(ripgrep), { recursive: true })
    writeFileSync(ripgrep, '#!/bin/sh\n', { mode: 0o755 })
    await pack()
    const directory = await ensureDesktopRuntime({ archive, home, version: '1.0.0' })
    expect(statSync(join(directory, 'node_modules/@vscode/ripgrep-arm64/bin/rg')).mode & 0o777).toBe(0o755)
    const marker = JSON.parse(readFileSync(join(directory, DESKTOP_RUNTIME_MARKER), 'utf8')) as { restored: string[] }
    expect(marker.restored).toEqual([])
  })

  it('names the archive the application looks for', () => {
    expect(DESKTOP_RUNTIME_ARCHIVE).toBe('desktop-runtime.tar.zst')
    expect(DESKTOP_RUNTIME_ARCHIVE_DIGEST).toBe('desktop-runtime.tar.zst.sha256')
  })
})

describe('the tree digest', () => {
  it('depends on contents and paths, not on read order', async () => {
    const first = await treeDigest(tree)
    expect(await treeDigest(tree)).toBe(first)
    writeFileSync(join(tree, 'README.md'), '# changed\n')
    expect(await treeDigest(tree)).not.toBe(first)
    writeFileSync(join(tree, 'node_modules/demo/extra.js'), 'export const extra = 2\n')
    expect(await treeDigest(tree)).not.toBe(first)
  })

  it('leaves out the file that records it', async () => {
    writeFileSync(join(tree, DESKTOP_RUNTIME_MARKER), '{}\n')
    const withMarker = await treeDigest(tree)
    const withoutMarker = await treeDigest(tree, join(tree, DESKTOP_RUNTIME_MARKER))
    expect(withMarker).not.toBe(withoutMarker)
    writeFileSync(join(tree, 'README.md'), '# rewritten\n')
    expect(await treeDigest(tree)).not.toBe(withMarker)
    expect(await treeDigest(tree, join(tree, DESKTOP_RUNTIME_MARKER))).not.toBe(withoutMarker)
  })

  it('digests a file by its bytes', async () => {
    expect(await fileDigest(join(tree, 'README.md'))).toMatch(/^[0-9a-f]{64}$/u)
    expect(await fileDigest(join(tree, 'README.md'))).not.toBe(await fileDigest(join(tree, 'node_modules/demo/package.json')))
  })
})
