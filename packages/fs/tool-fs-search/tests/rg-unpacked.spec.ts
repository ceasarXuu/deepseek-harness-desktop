/**
 * The archive rule for the packaged binary path. A packaged deployment ships
 * its closure inside an Electron archive, so `@vscode/ripgrep` resolves the
 * binary to a path that runs through the archive — a path no process launch can
 * execute. `resolveRgPath()` must hand the search tools the unpacked sibling
 * the archive's unpack rules place beside it.
 *
 * Each case needs its own module instance, because the resolution is memoized
 * per process and the platform path differs per case.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'dsh-rg-archive-'))
const platformPath = 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
const archivePath = join(root, 'harness.asar', platformPath)
const unpackedPath = join(root, 'harness.asar.unpacked', platformPath)
const loosePath = join(root, 'loose', 'bin', 'rg')

mkdirSync(dirname(unpackedPath), { recursive: true })
writeFileSync(unpackedPath, '')
mkdirSync(dirname(loosePath), { recursive: true })
writeFileSync(loosePath, '')

/** The path the mocked platform module resolves to; replaced per case. */
const resolved = { path: archivePath }

vi.mock('@vscode/ripgrep', () => ({
  get rgPath() {
    return resolved.path
  },
}))

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** Resolve the packaged binary path for one platform-module outcome. */
async function resolveFor(path: string): Promise<string> {
  resolved.path = path
  vi.resetModules()
  const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')
  return resolveRgPath()
}

describe('packaged ripgrep path', () => {
  it('unwraps a path inside an archive to the unpacked sibling a process can launch', async () => {
    await expect(resolveFor(archivePath)).resolves.toBe(unpackedPath)
  })

  it('leaves an unpackaged path alone', async () => {
    await expect(resolveFor(loosePath)).resolves.toBe(loosePath)
  })

  it('leaves an archive path alone when no unpacked sibling exists', async () => {
    const absent = join(root, 'other.asar', platformPath)
    await expect(resolveFor(absent)).resolves.toBe(absent)
  })
})
