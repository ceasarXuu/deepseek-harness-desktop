import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  downloadReleaseAsset,
  uploadReleaseAsset,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
} from '../scripts/github-release-client.ts'

const temporaryDirectories: string[] = []
const RELEASE_ID = 42

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

/** The URL one request went to, however the caller spelled it. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** One asset as the release listings in the tests report it. */
function asset(id: number, name: string, size: number): GitHubReleaseAsset {
  return {
    id,
    name,
    size,
    created_at: '2026-09-14T13:44:00Z',
    updated_at: '2026-09-14T13:44:00Z',
    url: `https://api.github.com/repos/example/repo/releases/assets/${String(id)}`,
    browser_download_url: 'https://github.com/example/repo/releases/download/v1/name',
  }
}

async function fixture(contents: string): Promise<{ path: string; size: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-upload-client-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'rc-mac.yml')
  await writeFile(path, contents)
  return { path, size: Buffer.byteLength(contents) }
}

interface Stub {
  readonly client: GitHubReleaseClient
  readonly requests: readonly RecordedRequest[]
  readonly logs: readonly string[]
}

/**
 * Build a client whose transport answers the release listing and the asset endpoints from a script.
 * @param listings - Assets each successive release listing reports, oldest list first.
 * @param uploadStatuses - Status each successive asset upload answers with.
 * @returns The client, the requests it made, and the progress lines it printed.
 */
function stubClient(
  listings: readonly (readonly GitHubReleaseAsset[])[],
  uploadStatuses: readonly number[],
): Stub {
  const requests: RecordedRequest[] = []
  const logs: string[] = []
  let listingIndex = 0
  let uploadIndex = 0
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input)
    const method = init?.method ?? 'GET'
    requests.push({ method, url })
    if (method === 'GET') {
      const listed = listings[Math.min(listingIndex, listings.length - 1)] ?? []
      listingIndex += 1
      return Response.json(listed)
    }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'POST') {
      const status = uploadStatuses[Math.min(uploadIndex, uploadStatuses.length - 1)] ?? 201
      uploadIndex += 1
      return status === 422
        ? Response.json({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }, { status })
        : Response.json({ id: 99, name: 'rc-mac.yml' }, { status })
    }
    throw new Error(`unexpected ${method} ${url}`)
  }
  return {
    client: { token: 'token', owner: 'example', repo: 'repo', transport, log: message => logs.push(message) },
    requests,
    logs,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

describe('the release asset uploader', () => {
  it('replaces a same-named asset the release already lists', async () => {
    const file = await fixture('version: 1.2.3\n')
    const stub = stubClient([[asset(7, 'rc-mac.yml', file.size)]], [201])
    await uploadReleaseAsset(stub.client, RELEASE_ID, {
      path: file.path,
      filename: 'rc-mac.yml',
      contentType: 'application/yaml',
    })
    expect(stub.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      `GET https://api.github.com/repos/example/repo/releases/${String(RELEASE_ID)}/assets?per_page=100`,
      'DELETE https://api.github.com/repos/example/repo/releases/assets/7',
      `POST https://uploads.github.com/repos/example/repo/releases/${String(RELEASE_ID)}/assets?name=rc-mac.yml`,
    ])
    expect(stub.logs).toContain('desktop upload: removed previous rc-mac.yml')
  })

  it('removes the name and retries once when the release rejects the upload as already existing', async () => {
    const file = await fixture('version: 1.2.3\n')
    // The first listing is empty (the release carries nothing named `rc-mac.yml` yet); the second
    // reports the asset a concurrent lane created between the read and the upload.
    const stub = stubClient([[], [asset(7, 'rc-mac.yml', file.size)]], [422, 201])
    await uploadReleaseAsset(stub.client, RELEASE_ID, {
      path: file.path,
      filename: 'rc-mac.yml',
      contentType: 'application/yaml',
    })
    const uploads = stub.requests.filter(request => request.method === 'POST')
    const deletions = stub.requests.filter(request => request.method === 'DELETE')
    expect(uploads).toHaveLength(2)
    expect(deletions.map(request => request.url)).toEqual(['https://api.github.com/repos/example/repo/releases/assets/7'])
    expect(stub.requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET', 'DELETE', 'POST'])
    expect(stub.logs.at(-1)).toMatch(/uploaded rc-mac\.yml/u)
  })

  it('reports a rejection that is not a name conflict without retrying', async () => {
    const file = await fixture('version: 1.2.3\n')
    const stub = stubClient([[]], [500])
    await expect(uploadReleaseAsset(stub.client, RELEASE_ID, {
      path: file.path,
      filename: 'rc-mac.yml',
      contentType: 'application/yaml',
    })).rejects.toThrow(/GitHub POST .* exited with 500/u)
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })
})

describe('the release asset downloader', () => {
  it('writes the asset bytes and checks them against the size the release reports', async () => {
    const contents = 'version: 1.2.3\nfiles: []\n'
    const requests: RecordedRequest[] = []
    const transport: typeof fetch = async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: requestUrl(input) })
      return new Response(contents, { status: 200 })
    }
    const client: GitHubReleaseClient = { token: 'token', owner: 'example', repo: 'repo', transport }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-download-'))
    temporaryDirectories.push(directory)
    const listed = asset(7, 'rc-mac.yml', Buffer.byteLength(contents))
    const written = await downloadReleaseAsset(client, listed, join(directory, 'rc-mac.yml'))
    expect(written).toBe(Buffer.byteLength(contents))
    expect(requests).toEqual([{ method: 'GET', url: listed.url }])
    await expect(downloadReleaseAsset(client, asset(8, 'rc-mac.yml', 1), join(directory, 'other.yml')))
      .rejects.toThrow(new RegExp(`wrote ${String(Buffer.byteLength(contents))} bytes but the release reports 1`, 'u'))
  })
})
