/**
 * The closure's integrity rule: the archive is checked against the digest the
 * signed bundle records, and the expanded tree against the digest recorded when
 * it was written. These cases pin both halves, including what a mismatch does —
 * expanding again rather than starting from a tree nobody vouched for.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureClosure, fileDigest, treeDigest } from '../src/closure.ts'

let root: string
let files: string
let archive: string
let home: string

/** Write the small tree the archive will hold. */
function writeTree(): void {
  mkdirSync(join(files, 'node_modules/demo/lib'), { recursive: true })
  writeFileSync(join(files, 'node_modules/demo/package.json'), '{"name":"demo"}\n')
  writeFileSync(join(files, 'node_modules/demo/lib/index.js'), 'export const value = 1\n')
  writeFileSync(join(files, 'README.md'), '# fixture\n')
}

/** Pack the tree and write the digest the application ships beside it. */
async function pack(): Promise<void> {
  await pipeline(tar.c({ cwd: files, portable: true }, ['.']), createZstdCompress(), createWriteStream(archive))
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(archive)) digest.update(chunk)
  writeFileSync(`${archive}.sha256`, `${digest.digest('hex')}\n`)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-closure-'))
  files = join(root, 'tree')
  archive = join(root, 'closure.tar.zst')
  home = join(root, 'home')
  mkdirSync(files, { recursive: true })
  writeTree()
  await pack()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('expanding the closure', () => {
  it('expands a verified archive and records both digests', async () => {
    const directory = await ensureClosure({ archive, home, version: '1.0.0' })
    expect(readFileSync(join(directory, 'node_modules/demo/package.json'), 'utf8')).toContain('demo')
    const marker = JSON.parse(readFileSync(join(directory, '.complete'), 'utf8')) as { archiveSha256: string; treeSha256: string }
    expect(marker.archiveSha256).toBe(readFileSync(`${archive}.sha256`, 'utf8').trim())
    expect(marker.treeSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does no work when the recorded tree is still the one on disk', async () => {
    const directory = await ensureClosure({ archive, home, version: '1.0.0' })
    const before = statSync(join(directory, 'README.md')).mtimeMs
    const messages: string[] = []
    const again = await ensureClosure({ archive, home, version: '1.0.0', onProgress: message => messages.push(message) })
    expect(again).toBe(directory)
    expect(messages).toEqual([])
    expect(statSync(join(directory, 'README.md')).mtimeMs).toBe(before)
  })
})

describe('a closure that no longer matches', () => {
  it('does not trust a tree whose contents changed, and expands it again', async () => {
    const directory = await ensureClosure({ archive, home, version: '1.0.0' })
    writeFileSync(join(directory, 'node_modules/demo/lib/index.js'), 'export const value = 666\n')
    const messages: string[] = []
    await ensureClosure({ archive, home, version: '1.0.0', onProgress: message => messages.push(message) })
    expect(readFileSync(join(directory, 'node_modules/demo/lib/index.js'), 'utf8')).toBe('export const value = 1\n')
    expect(messages).toContain('expanding the runtime closure')
  })

  it('removes a file added to the tree', async () => {
    const directory = await ensureClosure({ archive, home, version: '1.0.0' })
    writeFileSync(join(directory, 'node_modules/demo/injected.js'), 'process.exit(1)\n')
    await ensureClosure({ archive, home, version: '1.0.0' })
    expect(() => readFileSync(join(directory, 'node_modules/demo/injected.js'))).toThrow()
  })

  it('refuses an archive that does not match the shipped digest', async () => {
    const content = readFileSync(archive)
    content[content.length - 1] = (content[content.length - 1]! ^ 0xff) & 0xff
    writeFileSync(archive, content)
    await expect(ensureClosure({ archive, home, version: '1.0.0' })).rejects.toThrow(/reinstall the application/)
  })

  it('refuses when the shipped digest is absent', async () => {
    rmSync(`${archive}.sha256`)
    await expect(ensureClosure({ archive, home, version: '1.0.0' })).rejects.toThrow(/digest is missing/)
  })

  it('refuses when the shipped digest is not a digest', async () => {
    writeFileSync(`${archive}.sha256`, 'not-a-digest\n')
    await expect(ensureClosure({ archive, home, version: '1.0.0' })).rejects.toThrow(/not a sha256/)
  })
})

describe('the tree digest', () => {
  it('depends on contents and paths, not on read order', async () => {
    const first = await treeDigest(files)
    expect(await treeDigest(files)).toBe(first)
    writeFileSync(join(files, 'README.md'), '# changed\n')
    expect(await treeDigest(files)).not.toBe(first)
  })

  it('leaves out the file that records it', async () => {
    writeFileSync(join(files, '.complete'), '{}\n')
    const withMarker = await treeDigest(files)
    const withoutMarker = await treeDigest(files, join(files, '.complete'))
    expect(withMarker).not.toBe(withoutMarker)
  })

  it('digests a file by its bytes', async () => {
    const expected = createHash('sha256').update('# fixture\n').digest('hex')
    expect(await fileDigest(join(files, 'README.md'))).toBe(expected)
  })
})
