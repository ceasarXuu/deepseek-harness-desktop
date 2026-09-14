/** Upload one validated Desktop release to its GitHub release. */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { resolveDesktopUploadToken } from './desktop-auto-update-environment.mjs'
import {
  createDesktopUploadPlan,
  type DesktopUploadAsset,
  type DesktopUploadPlan,
} from './desktop-upload-plan.ts'

const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])
const API_ROOT = 'https://api.github.com'
const UPLOAD_ROOT = 'https://uploads.github.com'

/** A release asset already attached to the destination release. */
interface GitHubAsset {
  readonly id: number
  readonly name: string
}

/** The destination release, created or reused by one upload. */
interface GitHubRelease {
  readonly id: number
  readonly prerelease: boolean
  readonly assets: readonly GitHubAsset[]
}

function targetName(value: string): DesktopPackageTargetName {
  if (!SUPPORTED_TARGETS.has(value as DesktopPackageTargetName)) {
    throw new Error(`desktop upload: unsupported target ${JSON.stringify(value)}; expected ${[...SUPPORTED_TARGETS].join(', ')}`)
  }
  return value as DesktopPackageTargetName
}

/** Fetch with the API headers, failing on any response that is not a success. */
async function githubRequest(
  token: string,
  url: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  })
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    const detail = await response.text().catch(() => '')
    throw new Error(`desktop upload: GitHub ${init.method ?? 'GET'} ${url} exited with ${String(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 400)}`}`)
  }
  return response
}

/** Read the destination release, or undefined when the tag has none yet. */
async function findRelease(token: string, plan: DesktopUploadPlan): Promise<GitHubRelease | undefined> {
  const url = `${API_ROOT}/repos/${plan.owner}/${plan.repo}/releases/tags/${encodeURIComponent(plan.tag)}`
  const response = await githubRequest(token, url, {}, true)
  if (response.status === 404) return undefined
  return await response.json() as GitHubRelease
}

/**
 * Create the release when the tag has none, and align its prerelease flag with the version.
 * @param token - GitHub credential.
 * @param plan - Validated upload plan naming the repository, tag, and release type.
 * @returns The destination release.
 */
async function ensureRelease(token: string, plan: DesktopUploadPlan): Promise<GitHubRelease> {
  const existing = await findRelease(token, plan)
  const prerelease = plan.releaseType === 'prerelease'
  if (existing === undefined) {
    const response = await githubRequest(token, `${API_ROOT}/repos/${plan.owner}/${plan.repo}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: plan.tag, name: plan.tag, prerelease, draft: false }),
    })
    process.stdout.write(`desktop upload: created GitHub release ${plan.tag}\n`)
    return await response.json() as GitHubRelease
  }
  if (existing.prerelease !== prerelease) {
    const response = await githubRequest(token, `${API_ROOT}/repos/${plan.owner}/${plan.repo}/releases/${String(existing.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prerelease }),
    })
    process.stdout.write(`desktop upload: release ${plan.tag} prerelease=${String(prerelease)}\n`)
    return await response.json() as GitHubRelease
  }
  return existing
}

/** Remove an asset of the same name so a re-run replaces it instead of failing. */
async function replaceExistingAsset(
  token: string,
  plan: DesktopUploadPlan,
  release: GitHubRelease,
  asset: DesktopUploadAsset,
): Promise<void> {
  const existing = release.assets.find(entry => entry.name === asset.filename)
  if (existing === undefined) return
  await githubRequest(token, `${API_ROOT}/repos/${plan.owner}/${plan.repo}/releases/assets/${String(existing.id)}`, { method: 'DELETE' })
  process.stdout.write(`desktop upload: removed previous ${asset.filename}\n`)
}

/** Upload one local file as a release asset. */
async function uploadAsset(token: string, plan: DesktopUploadPlan, release: GitHubRelease, asset: DesktopUploadAsset): Promise<void> {
  const details = await stat(asset.path)
  const url = `${UPLOAD_ROOT}/repos/${plan.owner}/${plan.repo}/releases/${String(release.id)}/assets?name=${encodeURIComponent(asset.filename)}`
  const file = createReadStream(asset.path)
  // A release asset is hundreds of megabytes, so the body streams instead of buffering; `fetch`
  // reads a web stream and requires half-duplex mode for a request body.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': asset.contentType, 'content-length': String(details.size) },
    body: Readable.toWeb(file) as unknown as BodyInit,
    duplex: 'half',
  }
  try {
    await githubRequest(token, url, init)
  }
  finally {
    file.destroy()
  }
  process.stdout.write(`desktop upload: uploaded ${asset.filename} (${String(details.size)} bytes)\n`)
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    throw new Error('desktop upload: expected exactly one target')
  }
  const plan = await createDesktopUploadPlan(targetName(target))
  const token = resolveDesktopUploadToken(process.env)
  process.stdout.write(`desktop upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  const release = await ensureRelease(token, plan)
  for (const asset of plan.assets) {
    await replaceExistingAsset(token, plan, release, asset)
    await uploadAsset(token, plan, release, asset)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
