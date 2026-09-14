import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeChannelArtifact,
  writeAppUpdateConfiguration,
  writeMergedChannelMetadata,
  writeUpdateMetadata,
} from '../src/desktop-update-metadata.ts'

const temporaryDirectories: string[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-desktop-metadata-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

describe('the updater configuration', () => {
  it('names the release repository the updater resolves releases from', async () => {
    const resources = await root()
    const path = writeAppUpdateConfiguration(resources, {
      owner: 'example',
      repo: 'desktop-releases',
      releaseType: 'prerelease',
    })
    expect(path).toBe(join(resources, 'app-update.yml'))
    expect(load(await readFile(path, 'utf8'))).toEqual({
      provider: 'github',
      owner: 'example',
      repo: 'desktop-releases',
      releaseType: 'prerelease',
    })
  })
})

describe('the channel metadata', () => {
  it('describes the macOS updater payload with its digest and size', async () => {
    const artifacts = await root()
    await writeFile(join(artifacts, 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip'), 'signed zip fixture')
    const path = await writeUpdateMetadata(artifacts, '1.2.3-rc.4', 'mac-arm64', 'rc-mac.yml')
    const metadata = load(await readFile(path, 'utf8')) as {
      version: string
      files: { url: string; size: number; sha512: string }[]
      path: string
      sha512: string
      releaseDate: string
    }
    expect(path).toBe(join(artifacts, 'rc-mac.yml'))
    expect(metadata.version).toBe('1.2.3-rc.4')
    expect(metadata.files).toHaveLength(1)
    expect(metadata.files[0]).toMatchObject({
      url: 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip',
      size: (await stat(join(artifacts, 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip'))).size,
    })
    expect(metadata.files[0]?.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/u)
    expect(metadata.path).toBe(metadata.files[0]?.url)
    expect(metadata.sha512).toBe(metadata.files[0]?.sha512)
    expect(Number.isNaN(Date.parse(metadata.releaseDate))).toBe(false)
  })

  it('describes the Windows installer with the block map size differential updates need', async () => {
    const artifacts = await root()
    await writeFile(join(artifacts, 'deepseek-harness-2.0.0-win-x64.exe'), 'installer fixture')
    await writeFile(join(artifacts, 'deepseek-harness-2.0.0-win-x64.exe.blockmap'), 'block map fixture')
    const metadata = load(await readFile(
      await writeUpdateMetadata(artifacts, '2.0.0', 'win-x64', 'latest.yml'),
      'utf8',
    )) as { files: { url: string; blockMapSize: number }[] }
    expect(metadata.files[0]).toMatchObject({
      url: 'deepseek-harness-2.0.0-win-x64.exe',
      blockMapSize: 'block map fixture'.length,
    })
  })

  it('refuses to describe an artifact that is not there', async () => {
    const artifacts = await root()
    await mkdir(join(artifacts, 'empty'), { recursive: true })
    await writeFile(join(artifacts, 'empty.zip'), '')
    await expect(writeUpdateMetadata(artifacts, '1.2.3', 'mac-x64', 'latest-mac.yml'))
      .rejects.toThrow(/missing or empty artifact/u)
  })
})

describe('the merged channel metadata', () => {
  interface MergedMetadata {
    version: string
    files: { url: string; sha512: string; size: number }[]
    path: string
    sha512: string
    releaseDate: string
  }

  async function describeZips(artifacts: string, names: readonly string[]): Promise<MergedMetadata> {
    const described = await Promise.all(names.map(async name => describeChannelArtifact(join(artifacts, name))))
    const path = writeMergedChannelMetadata(artifacts, '1.2.3-rc.4', 'rc-mac.yml', described)
    expect(path).toBe(join(artifacts, 'rc-mac.yml'))
    return load(await readFile(path, 'utf8')) as MergedMetadata
  }

  it('names the ZIP of every architecture and falls back to the newest entry', async () => {
    const artifacts = await root()
    const arm64 = 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip'
    const x64 = 'deepseek-harness-1.2.3-rc.4-mac-x64.zip'
    await writeFile(join(artifacts, arm64), 'arm64 signed zip fixture')
    await writeFile(join(artifacts, x64), 'x64 signed zip fixture')
    const metadata = await describeZips(artifacts, [arm64, x64])
    expect(metadata.version).toBe('1.2.3-rc.4')
    expect(metadata.files.map(file => file.url)).toEqual([arm64, x64])
    expect(metadata.files.map(file => file.size)).toEqual([
      (await stat(join(artifacts, arm64))).size,
      (await stat(join(artifacts, x64))).size,
    ])
    const digests = metadata.files.map(file => file.sha512)
    expect(digests.every(digest => /^[A-Za-z0-9+/]{86}==$/u.test(digest))).toBe(true)
    expect(new Set(digests).size).toBe(2)
    expect(metadata.path).toBe(x64)
    expect(metadata.sha512).toBe(digests[1])
    expect(Number.isNaN(Date.parse(metadata.releaseDate))).toBe(false)
  })

  it('describes a release that carries one architecture alone', async () => {
    const artifacts = await root()
    const arm64 = 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip'
    await writeFile(join(artifacts, arm64), 'arm64 signed zip fixture')
    const metadata = await describeZips(artifacts, [arm64])
    expect(metadata.files).toHaveLength(1)
    expect(metadata.files[0]?.url).toBe(arm64)
    expect(metadata.path).toBe(arm64)
    expect(metadata.sha512).toBe(metadata.files[0]?.sha512)
  })

  it('refuses to write a channel file that names no artifact', async () => {
    const artifacts = await root()
    expect(() => writeMergedChannelMetadata(artifacts, '1.2.3-rc.4', 'rc-mac.yml', []))
      .toThrow(/needs at least one artifact/u)
    const zip = join(artifacts, 'deepseek-harness-1.2.3-rc.4-mac-arm64.zip')
    await writeFile(zip, 'arm64 signed zip fixture')
    const described = await describeChannelArtifact(zip)
    expect(() => writeMergedChannelMetadata(artifacts, '1.2.3-rc.4', 'rc-mac.yml', [described, described]))
      .toThrow(/names one artifact twice/u)
  })
})
