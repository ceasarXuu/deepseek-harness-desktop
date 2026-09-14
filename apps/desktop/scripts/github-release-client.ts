/** GitHub release REST operations the Desktop upload steps share. */

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const API_ROOT = 'https://api.github.com'
const UPLOAD_ROOT = 'https://uploads.github.com'
/** Characters of a failure body kept in the thrown message. */
const FAILURE_DETAIL_LIMIT = 400

/** One asset the REST API reports on a release. */
export interface GitHubReleaseAsset {
  readonly id: number
  readonly name: string
  readonly size: number
  readonly created_at: string
  readonly updated_at: string
  readonly url: string
  readonly browser_download_url: string
}

/** A release the upload steps publish to. */
export interface GitHubRelease {
  readonly id: number
  readonly prerelease: boolean
  readonly assets: readonly GitHubReleaseAsset[]
}

/** Repository, credential, and transport one upload step acts with. */
export interface GitHubReleaseClient {
  readonly token: string
  readonly owner: string
  readonly repo: string
  /** Transport every request goes through; defaults to the global `fetch`. */
  readonly transport?: typeof fetch
  /** Progress sink; defaults to standard output. */
  readonly log?: (message: string) => void
}

/** One local file to publish as a release asset. */
export interface GitHubAssetUpload {
  readonly path: string
  readonly filename: string
  readonly contentType: string
}

/** A response the caller must inspect, such as an asset upload the API rejected. */
export class GitHubRequestError extends Error {
  /** HTTP status the API answered with. */
  readonly status: number

  /** Response body, truncated for a readable message. */
  readonly body: string

  /**
   * Build the error one rejected request throws.
   * @param method - Request method.
   * @param url - Absolute request URL.
   * @param status - HTTP status the API answered with.
   * @param body - Response body, already truncated.
   */
  constructor(method: string, url: string, status: number, body: string) {
    super(`desktop upload: GitHub ${method} ${url} exited with ${String(status)}${body === '' ? '' : `: ${body}`}`)
    this.name = 'GitHubRequestError'
    this.status = status
    this.body = body
  }

  /** Whether the API refused the request because the asset name is already taken. */
  get alreadyExists(): boolean {
    return this.status === 422 && this.body.includes('already_exists')
  }
}

/** The transport a client sends through. */
function sender(client: GitHubReleaseClient): typeof fetch {
  return client.transport ?? fetch
}

/** The progress sink a client reports through. */
function reporter(client: GitHubReleaseClient): (message: string) => void {
  return client.log ?? ((message: string): void => { process.stdout.write(`${message}\n`) })
}

/**
 * Send one authenticated REST request, rejecting a response the caller did not allow.
 * @param client - Credential, repository, and transport.
 * @param url - Absolute REST URL.
 * @param init - Request method, headers, and body.
 * @param allowNotFound - Whether a 404 is returned instead of thrown.
 * @returns The response, which is a success or the allowed 404.
 */
export async function githubRequest(
  client: GitHubReleaseClient,
  url: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<Response> {
  const method = init.method ?? 'GET'
  const response = await sender(client)(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${client.token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  })
  if (response.ok || (allowNotFound && response.status === 404)) return response
  const detail = await response.text().catch(() => '')
  throw new GitHubRequestError(method, url, response.status, detail.slice(0, FAILURE_DETAIL_LIMIT))
}

/**
 * Read the release a tag carries, or undefined when the tag has none.
 * @param client - Credential, repository, and transport.
 * @param tag - Release tag.
 * @returns The release, or undefined.
 */
export async function findRelease(client: GitHubReleaseClient, tag: string): Promise<GitHubRelease | undefined> {
  const url = `${API_ROOT}/repos/${client.owner}/${client.repo}/releases/tags/${encodeURIComponent(tag)}`
  const response = await githubRequest(client, url, {}, true)
  if (response.status === 404) return undefined
  return await response.json() as GitHubRelease
}

/**
 * Create the release when the tag has none, and align its prerelease flag with the version.
 * @param client - Credential, repository, and transport.
 * @param tag - Release tag the version publishes under.
 * @param prerelease - Whether the released version is a prerelease.
 * @returns The destination release.
 */
export async function ensureRelease(client: GitHubReleaseClient, tag: string, prerelease: boolean): Promise<GitHubRelease> {
  const existing = await findRelease(client, tag)
  if (existing === undefined) {
    const response = await githubRequest(client, `${API_ROOT}/repos/${client.owner}/${client.repo}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: tag, prerelease, draft: false }),
    })
    reporter(client)(`desktop upload: created GitHub release ${tag}`)
    return await response.json() as GitHubRelease
  }
  if (existing.prerelease !== prerelease) {
    const response = await githubRequest(client, `${API_ROOT}/repos/${client.owner}/${client.repo}/releases/${String(existing.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prerelease }),
    })
    reporter(client)(`desktop upload: release ${tag} prerelease=${String(prerelease)}`)
    return await response.json() as GitHubRelease
  }
  return existing
}

/**
 * Read the assets the release currently carries.
 *
 * The caller re-reads rather than trusting a release object it fetched earlier: two macOS lanes
 * upload into one release at the same time, so any snapshot is already stale.
 * @param client - Credential, repository, and transport.
 * @param releaseId - Release to list.
 * @returns The assets on the release.
 */
export async function listReleaseAssets(
  client: GitHubReleaseClient,
  releaseId: number,
): Promise<readonly GitHubReleaseAsset[]> {
  const url = `${API_ROOT}/repos/${client.owner}/${client.repo}/releases/${String(releaseId)}/assets?per_page=100`
  const response = await githubRequest(client, url)
  const parsed: unknown = await response.json()
  if (!Array.isArray(parsed)) throw new Error(`desktop upload: GitHub release ${String(releaseId)} assets response is not a list`)
  return parsed as readonly GitHubReleaseAsset[]
}

/**
 * Delete one asset so a same-named upload replaces it instead of failing.
 * @param client - Credential, repository, and transport.
 * @param asset - Asset to remove.
 */
export async function deleteReleaseAsset(client: GitHubReleaseClient, asset: GitHubReleaseAsset): Promise<void> {
  await githubRequest(client, `${API_ROOT}/repos/${client.owner}/${client.repo}/releases/assets/${String(asset.id)}`, { method: 'DELETE' })
  reporter(client)(`desktop upload: removed previous ${asset.name}`)
}

/**
 * Remove every asset of one name from a release.
 * @param client - Credential, repository, and transport.
 * @param releaseId - Release to clean.
 * @param name - Asset name to remove.
 */
async function deleteAssetByName(client: GitHubReleaseClient, releaseId: number, name: string): Promise<void> {
  const assets = await listReleaseAssets(client, releaseId)
  for (const asset of assets.filter(entry => entry.name === name)) {
    await deleteReleaseAsset(client, asset)
  }
}

/** Stream one local file into the asset upload endpoint, which rejects a taken name. */
async function sendAssetUpload(client: GitHubReleaseClient, releaseId: number, upload: GitHubAssetUpload): Promise<void> {
  const details = await stat(upload.path)
  const url = `${UPLOAD_ROOT}/repos/${client.owner}/${client.repo}/releases/${String(releaseId)}/assets?name=${encodeURIComponent(upload.filename)}`
  const file = createReadStream(upload.path)
  // A release asset is hundreds of megabytes, so the body streams instead of buffering; `fetch`
  // reads a web stream and requires half-duplex mode for a request body.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': upload.contentType, 'content-length': String(details.size) },
    body: Readable.toWeb(file) as unknown as BodyInit,
    duplex: 'half',
  }
  try {
    await githubRequest(client, url, init)
  }
  finally {
    file.destroy()
  }
  reporter(client)(`desktop upload: uploaded ${upload.filename} (${String(details.size)} bytes)`)
}

/**
 * Publish one local file as a release asset, replacing any asset that already carries its name.
 *
 * The upload plan is validated before any network call, but a second lane finishes after the
 * first read the release, so the name can be taken by the time this upload starts. Re-reading the
 * assets covers a name that was there all along, and a `422 already_exists` refusal means one
 * appeared in between, so that name is removed and the upload retried exactly once.
 * @param client - Credential, repository, and transport.
 * @param releaseId - Destination release.
 * @param upload - Local file and the asset it becomes.
 */
export async function uploadReleaseAsset(
  client: GitHubReleaseClient,
  releaseId: number,
  upload: GitHubAssetUpload,
): Promise<void> {
  await deleteAssetByName(client, releaseId, upload.filename)
  try {
    await sendAssetUpload(client, releaseId, upload)
  }
  catch (error) {
    if (!(error instanceof GitHubRequestError) || !error.alreadyExists) throw error
    reporter(client)(`desktop upload: ${upload.filename} already exists on the release; removing it and retrying once`)
    await deleteAssetByName(client, releaseId, upload.filename)
    await sendAssetUpload(client, releaseId, upload)
  }
}

/**
 * Download one release asset to a local file.
 *
 * The API answers an asset read with a redirect, and the body is a build artifact of hundreds of
 * megabytes, so the bytes stream to disk instead of buffering, and the written length is checked
 * against the length the release reports for the asset.
 * @param client - Credential, repository, and transport.
 * @param asset - Asset to download.
 * @param destination - Absolute path the bytes are written to.
 * @returns The number of bytes written.
 */
export async function downloadReleaseAsset(
  client: GitHubReleaseClient,
  asset: GitHubReleaseAsset,
  destination: string,
): Promise<number> {
  const response = await githubRequest(client, asset.url, { headers: { accept: 'application/octet-stream' } })
  const body = response.body
  if (body === null) throw new Error(`desktop download: ${asset.name} answered without a body`)
  await pipeline(body as unknown as AsyncIterable<Uint8Array>, createWriteStream(destination))
  const details = await stat(destination)
  if (details.size !== asset.size) {
    throw new Error(`desktop download: ${asset.name} wrote ${String(details.size)} bytes but the release reports ${String(asset.size)}`)
  }
  reporter(client)(`desktop download: ${asset.name} (${String(details.size)} bytes)`)
  return details.size
}
