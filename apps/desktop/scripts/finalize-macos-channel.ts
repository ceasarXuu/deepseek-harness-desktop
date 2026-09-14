/** Publish the single macOS channel file naming every architecture's updater ZIP. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import {
  describeChannelArtifact,
  writeMergedChannelMetadata,
  type DesktopChannelArtifact,
} from '../src/desktop-update-metadata.ts'
import {
  desktopUpdateMetadataFilename,
  resolveDesktopReleaseDestination,
  resolveDesktopUploadToken,
} from './desktop-auto-update-environment.mjs'
import {
  downloadReleaseAsset,
  findRelease,
  listReleaseAssets,
  uploadReleaseAsset,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
} from './github-release-client.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

/** One channel file as electron-updater parses it. */
export interface MacChannelMetadata {
  readonly version: string
  readonly files: readonly DesktopChannelArtifact[]
  readonly path: string
  readonly sha512: string
  readonly releaseDate: string
}

/** Inputs the merged channel-file assembly needs. */
export interface AssembleChannelOptions {
  readonly client: GitHubReleaseClient
  readonly releaseId: number
  readonly version: string
  readonly metadataFilename: string
  readonly directory: string
}

/** Inputs the merged channel-file check needs. */
export interface ValidateChannelOptions {
  readonly client: GitHubReleaseClient
  readonly releaseId: number
  readonly version: string
  readonly metadataPath: string
  readonly expected: readonly DesktopChannelArtifact[]
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop release: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop release: ${label} must be a non-empty string`)
  }
  return value
}

function sizeValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`desktop release: ${label} must be a positive integer`)
  }
  return value
}

/**
 * Select the updater ZIPs a merged channel file must name.
 * @param assets - Assets the release carries.
 * @param version - Released version the artifact base is built from.
 * @returns Matching assets, oldest upload first.
 */
export function macUpdaterZipAssets(
  assets: readonly GitHubReleaseAsset[],
  version: string,
): readonly GitHubReleaseAsset[] {
  const prefix = `deepseek-harness-${version}-mac-`
  const suffix = '.zip'
  return assets
    .filter(asset => asset.name.startsWith(prefix)
      && asset.name.endsWith(suffix)
      && asset.name.length > prefix.length + suffix.length)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name))
}

/**
 * Read a merged channel file back, refusing anything electron-updater would reject.
 * @param path - Absolute path of the channel file.
 * @returns The parsed channel file.
 */
export async function loadChannelMetadata(path: string): Promise<MacChannelMetadata> {
  const metadata = objectValue(load(await readFile(path, 'utf8')), basename(path))
  const files = metadata.files
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`desktop release: ${basename(path)}.files must list at least one updater ZIP`)
  }
  const entries = files.map((entry, index) => {
    const file = objectValue(entry, `${basename(path)}.files[${String(index)}]`)
    return {
      filename: stringValue(file.url, `${basename(path)}.files[${String(index)}].url`),
      sha512: stringValue(file.sha512, `${basename(path)}.files[${String(index)}].sha512`),
      size: sizeValue(file.size, `${basename(path)}.files[${String(index)}].size`),
    }
  })
  return {
    version: stringValue(metadata.version, `${basename(path)}.version`),
    files: entries,
    path: stringValue(metadata.path, `${basename(path)}.path`),
    sha512: stringValue(metadata.sha512, `${basename(path)}.sha512`),
    // js-yaml parses an unquoted ISO timestamp into a Date, which is what a hand-written file states.
    releaseDate: metadata.releaseDate instanceof Date
      ? metadata.releaseDate.toISOString()
      : stringValue(metadata.releaseDate, `${basename(path)}.releaseDate`),
  }
}

/**
 * Check a channel file against the release it is about to be published to.
 *
 * Every entry must name an asset the release carries, with the byte size the release itself
 * reports and the SHA-512 the bytes downloaded from that asset produced, and the fallback
 * `path`/`sha512` pair must be the newest entry's.
 * @param options - Client, release, version, channel file, and the artifacts it was assembled from.
 */
export async function validateChannelMetadata(options: ValidateChannelOptions): Promise<void> {
  const metadata = await loadChannelMetadata(options.metadataPath)
  if (metadata.version !== options.version) {
    throw new Error(`desktop release: ${basename(options.metadataPath)} states version ${metadata.version}, not ${options.version}`)
  }
  if (metadata.files.length !== options.expected.length) {
    throw new Error(`desktop release: ${basename(options.metadataPath)} names ${String(metadata.files.length)} files, not ${String(options.expected.length)}`)
  }
  const assets = await listReleaseAssets(options.client, options.releaseId)
  for (const artifact of options.expected) {
    const entry = metadata.files.find(file => file.filename === artifact.filename)
    if (entry === undefined) throw new Error(`desktop release: ${basename(options.metadataPath)} does not name ${artifact.filename}`)
    if (entry.size !== artifact.size || entry.sha512 !== artifact.sha512) {
      throw new Error(`desktop release: ${basename(options.metadataPath)} disagrees with the downloaded ${artifact.filename}`)
    }
    const asset = assets.find(candidate => candidate.name === artifact.filename)
    if (asset === undefined) {
      throw new Error(`desktop release: release ${String(options.releaseId)} does not carry ${artifact.filename}`)
    }
    if (asset.size !== entry.size) {
      throw new Error(`desktop release: the release reports ${String(asset.size)} bytes for ${artifact.filename}, the channel file states ${String(entry.size)}`)
    }
  }
  const newest = options.expected.at(-1)
  if (newest === undefined || metadata.path !== newest.filename || metadata.sha512 !== newest.sha512) {
    throw new Error(`desktop release: ${basename(options.metadataPath)} must fall back to its newest entry, ${newest === undefined ? 'none' : newest.filename}`)
  }
}

/**
 * Assemble the merged macOS channel file from the ZIPs the release carries, and check it.
 * @param options - Client, release, version, channel file name, and the directory to build in.
 * @returns Absolute path of the written, checked channel file.
 */
export async function assembleMacChannelMetadata(options: AssembleChannelOptions): Promise<string> {
  const zips = macUpdaterZipAssets(await listReleaseAssets(options.client, options.releaseId), options.version)
  if (zips.length === 0) {
    throw new Error(`desktop release: release ${String(options.releaseId)} carries no deepseek-harness-${options.version}-mac-*.zip asset`)
  }
  const artifacts: DesktopChannelArtifact[] = []
  for (const asset of zips) {
    const path = join(options.directory, asset.name)
    await downloadReleaseAsset(options.client, asset, path)
    artifacts.push(await describeChannelArtifact(path))
  }
  const metadataPath = writeMergedChannelMetadata(options.directory, options.version, options.metadataFilename, artifacts)
  await validateChannelMetadata({
    client: options.client,
    releaseId: options.releaseId,
    version: options.version,
    metadataPath,
    expected: artifacts,
  })
  return metadataPath
}

/**
 * Read the version one manifest states.
 * @param path - Absolute path of the manifest.
 * @param label - Manifest name used in the error message.
 * @returns The declared version.
 */
async function manifestVersion(path: string, label: string): Promise<string> {
  const manifest = objectValue(JSON.parse(await readFile(path, 'utf8')), label)
  return stringValue(manifest.version, `${label}.version`)
}

async function main(): Promise<void> {
  const version = await manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = await manifestVersion(join(REPOSITORY_ROOT, 'package.json'), 'dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop release: desktop version ${version} does not match dsh version ${dshVersion}`)
  }
  const destination = resolveDesktopReleaseDestination(process.env, version)
  const metadataFilename = desktopUpdateMetadataFilename(version, 'darwin')
  const client: GitHubReleaseClient = {
    token: resolveDesktopUploadToken(process.env),
    owner: destination.owner,
    repo: destination.repo,
  }
  const release = await findRelease(client, destination.tag)
  if (release === undefined) {
    throw new Error(`desktop release: ${destination.tag} has no ${client.owner}/${client.repo} release to finalize`)
  }
  process.stdout.write(`desktop release: finalizing ${metadataFilename} of ${destination.tag}\n`)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-channel-'))
  try {
    const metadataPath = await assembleMacChannelMetadata({
      client,
      releaseId: release.id,
      version,
      metadataFilename,
      directory,
    })
    await uploadReleaseAsset(client, release.id, {
      path: metadataPath,
      filename: basename(metadataPath),
      contentType: 'application/yaml',
    })
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
