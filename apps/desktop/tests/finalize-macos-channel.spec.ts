import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assembleMacChannelMetadata,
  loadChannelMetadata,
  macUpdaterZipAssets,
  validateChannelMetadata,
} from '../scripts/finalize-macos-channel.ts'
import type { GitHubReleaseAsset, GitHubReleaseClient } from '../scripts/github-release-client.ts'

const temporaryDirectories: string[] = []
const RELEASE_ID = 42
const VERSION = '0.1.5-rc.2'
const ARM64 = `deepseek-harness-${VERSION}-mac-arm64.zip`
const X64 = `deepseek-harness-${VERSION}-mac-x64.zip`

function asset(id: number, name: string, size: number, createdAt: string): GitHubReleaseAsset {
  return {
    id,
    name,
    size,
    created_at: createdAt,
    updated_at: createdAt,
    url: `https://api.github.com/repos/example/repo/releases/assets/${String(id)}`,
    browser_download_url: `https://example.invalid/${name}`,
  }
}

interface Release {
  readonly assets: readonly GitHubReleaseAsset[]
  readonly bodies: ReadonlyMap<string, string>
}

/** The URL one request went to, however the caller spelled it. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Build a client whose transport serves the release listing and the asset bodies.
 * @param release - Assets and their contents.
 * @returns The client and the requests it made.
 */
function stubClient(release: Release): { client: GitHubReleaseClient; requests: string[] } {
  const requests: string[] = []
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('/releases/42/assets')) return Response.json(release.assets)
    const body = release.bodies.get(url)
    if (body === undefined) return new Response('missing', { status: 404 })
    return new Response(body, { status: 200 })
  }
  return {
    client: { token: 'token', owner: 'example', repo: 'example', transport, log: () => {} },
    requests,
  }
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-desktop-finalize-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

describe('the merged macOS channel file', () => {
  it('selects every architecture ZIP of the released version alone', async () => {
    const assets = [
      asset(1, `deepseek-harness-${VERSION}-mac-arm64.dmg`, 10, '2026-09-14T13:44:00Z'),
      asset(2, ARM64, 20, '2026-09-14T13:45:00Z'),
      asset(3, `${ARM64}.blockmap`, 5, '2026-09-14T13:45:00Z'),
      asset(4, X64, 30, '2026-09-14T13:46:00Z'),
      asset(5, 'deepseek-harness-0.1.4-mac-x64.zip', 7, '2026-09-01T00:00:00Z'),
      asset(6, 'rc-mac.yml', 9, '2026-09-14T13:47:00Z'),
    ]
    expect(macUpdaterZipAssets(assets, VERSION).map(entry => entry.name)).toEqual([ARM64, X64])
  })

  it('assembles the file from both lanes and falls back to the newest ZIP', async () => {
    const arm64Bytes = 'arm64 updater fixture'
    const x64Bytes = 'x64 updater fixture'
    const release: Release = {
      assets: [
        asset(2, ARM64, Buffer.byteLength(arm64Bytes), '2026-09-14T13:45:00Z'),
        asset(4, X64, Buffer.byteLength(x64Bytes), '2026-09-14T13:46:00Z'),
      ],
      bodies: new Map([
        ['https://api.github.com/repos/example/repo/releases/assets/2', arm64Bytes],
        ['https://api.github.com/repos/example/repo/releases/assets/4', x64Bytes],
      ]),
    }
    const stub = stubClient(release)
    const build = await directory()
    const path = await assembleMacChannelMetadata({
      client: stub.client,
      releaseId: RELEASE_ID,
      version: VERSION,
      metadataFilename: 'rc-mac.yml',
      directory: build,
    })
    expect(path).toBe(join(build, 'rc-mac.yml'))
    const metadata = await loadChannelMetadata(path)
    expect(metadata.version).toBe(VERSION)
    expect(metadata.files.map(file => file.filename)).toEqual([ARM64, X64])
    expect(metadata.files.map(file => file.size)).toEqual([Buffer.byteLength(arm64Bytes), Buffer.byteLength(x64Bytes)])
    expect(metadata.path).toBe(X64)
    expect(metadata.sha512).toBe(metadata.files[1]?.sha512)
    // One listing to select, one listing to validate the written file against the release.
    expect(stub.requests.filter(request => request.includes('/releases/42/assets'))).toHaveLength(2)
  })

  it('refuses to publish a file describing a ZIP the release does not carry', async () => {
    const stub = stubClient({ assets: [asset(1, `deepseek-harness-${VERSION}-mac-arm64.dmg`, 10, '2026-09-14T13:44:00Z')], bodies: new Map() })
    const build = await directory()
    await expect(assembleMacChannelMetadata({
      client: stub.client,
      releaseId: RELEASE_ID,
      version: VERSION,
      metadataFilename: 'rc-mac.yml',
      directory: build,
    })).rejects.toThrow(/carries no deepseek-harness-0\.1\.5-rc\.2-mac-\*\.zip asset/u)
  })

  it('rejects a downloaded ZIP whose length disagrees with the release', async () => {
    const stub = stubClient({
      assets: [asset(2, ARM64, 4, '2026-09-14T13:45:00Z')],
      bodies: new Map([['https://api.github.com/repos/example/repo/releases/assets/2', 'much longer bytes']]),
    })
    const build = await directory()
    await expect(assembleMacChannelMetadata({
      client: stub.client,
      releaseId: RELEASE_ID,
      version: VERSION,
      metadataFilename: 'rc-mac.yml',
      directory: build,
    })).rejects.toThrow(/wrote 17 bytes but the release reports 4/u)
  })

  it('rejects a channel file whose entry disagrees with the release asset', async () => {
    const stub = stubClient({ assets: [], bodies: new Map() })
    const build = await directory()
    const bytes = 'arm64 updater fixture'
    await writeChannelFile(build, { url: ARM64, size: bytes.length + 1, sha512: 'x' })
    await expect(validateChannelMetadata({
      client: stub.client,
      releaseId: RELEASE_ID,
      version: VERSION,
      metadataPath: join(build, 'rc-mac.yml'),
      expected: [{ filename: ARM64, size: bytes.length, sha512: 'x' }],
    })).rejects.toThrow(/disagrees with the downloaded/u)
  })
})

/** Write a channel file fixture whose single entry states the given fields. */
async function writeChannelFile(
  build: string,
  entry: { url: string; size: number; sha512: string },
): Promise<void> {
  const contents = [
    `version: ${VERSION}`,
    'files:',
    `  - url: ${entry.url}`,
    `    sha512: ${entry.sha512}`,
    `    size: ${String(entry.size)}`,
    `path: ${entry.url}`,
    `sha512: ${entry.sha512}`,
    'releaseDate: 2026-09-14T13:47:00.000Z',
    '',
  ].join('\n')
  await writeFile(join(build, 'rc-mac.yml'), contents)
}
