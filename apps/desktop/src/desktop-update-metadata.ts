/** Write the updater configuration the application carries and the channel metadata a release publishes. */

import { createHash } from 'node:crypto'
import { createReadStream, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dump } from 'js-yaml'

/** Provider fields `app-update.yml` carries for one resolved destination. */
export interface DesktopUpdateDestination {
  readonly owner: string
  readonly repo: string
  readonly releaseType: 'release' | 'prerelease'
}

/**
 * Write `app-update.yml` into the packaged application's resources.
 *
 * electron-builder writes this file only in a pass that builds an installer target, and this
 * application's installers are built from an already packaged directory, so the packaging step
 * writes it where the updater looks for it.
 * @param resourcesDir - `Contents/Resources` (or `resources`) of the application being packaged.
 * @param destination - Resolved GitHub release destination.
 * @returns Absolute path of the written configuration.
 */
export function writeAppUpdateConfiguration(resourcesDir: string, destination: DesktopUpdateDestination): string {
  const path = join(resourcesDir, 'app-update.yml')
  writeFileSync(path, dump({
    provider: 'github',
    owner: destination.owner,
    repo: destination.repo,
    releaseType: destination.releaseType,
  }))
  return path
}

/** One updater payload the channel metadata refers to. */
export interface DesktopChannelArtifact {
  readonly filename: string
  readonly size: number
  readonly sha512: string
}

/**
 * Describe one finished artifact so a channel file can state its size and digest.
 * @param path - Absolute path of the artifact.
 * @returns Its file name, byte size, and base64 SHA-512.
 */
export async function describeChannelArtifact(path: string): Promise<DesktopChannelArtifact> {
  const details = await stat(path).catch(() => undefined)
  if (details === undefined || !details.isFile() || details.size === 0) {
    throw new Error(`desktop update metadata: missing or empty artifact ${path}`)
  }
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { filename: basename(path), size: details.size, sha512: hash.digest('base64') }
}

/** One `files[]` entry as electron-updater reads it. */
function channelFileEntry(artifact: DesktopChannelArtifact): Record<string, unknown> {
  return {
    url: artifact.filename,
    sha512: artifact.sha512,
    size: artifact.size,
  }
}

/**
 * Write the channel metadata a release publishes for one target.
 *
 * The metadata names the updater payload for the running platform, so a macOS release points at
 * its ZIP while a Windows release points at its installer and states the block map size that
 * makes differential downloads possible.
 * @param artifactsRoot - Directory holding the finished artifacts.
 * @param version - Released version, which the updater compares against its own.
 * @param target - Released platform and architecture.
 * @param metadataFilename - Channel file name derived from the version and platform.
 * @returns Absolute path of the written metadata file.
 */
export async function writeUpdateMetadata(
  artifactsRoot: string,
  version: string,
  target: 'mac-arm64' | 'mac-x64' | 'win-x64',
  metadataFilename: string,
): Promise<string> {
  const [os, arch] = target.split('-')
  const base = `deepseek-harness-${version}-${os}-${arch}`
  const payload = target === 'win-x64' ? `${base}.exe` : `${base}.zip`
  const described = await describeChannelArtifact(join(artifactsRoot, payload))
  const file: Record<string, unknown> = channelFileEntry(described)
  if (target === 'win-x64') {
    file.blockMapSize = (await stat(join(artifactsRoot, `${payload}.blockmap`))).size
  }
  const path = join(artifactsRoot, metadataFilename)
  writeFileSync(path, dump({
    version,
    files: [file],
    path: described.filename,
    sha512: described.sha512,
    releaseDate: new Date().toISOString(),
  }))
  return path
}

/**
 * Write the one channel file a macOS release publishes for every architecture.
 *
 * electron-updater resolves a single `<channel>-mac.yml` per release and `MacUpdater.filterFilesForArch`
 * picks the entry whose URL matches the running machine, so a file naming one architecture hides
 * the others. The `finalize` step collects each lane's ZIP from the release and writes them here.
 * @param directory - Directory the channel file is written into.
 * @param version - Released version, which the updater compares against its own.
 * @param metadataFilename - Channel file name derived from the version.
 * @param artifacts - One entry per architecture ZIP, in release upload order (oldest first).
 * @returns Absolute path of the written metadata file.
 */
export function writeMergedChannelMetadata(
  directory: string,
  version: string,
  metadataFilename: string,
  artifacts: readonly DesktopChannelArtifact[],
): string {
  const newest = artifacts.at(-1)
  if (newest === undefined) {
    throw new Error(`desktop update metadata: ${metadataFilename} needs at least one artifact`)
  }
  if (new Set(artifacts.map(artifact => artifact.filename)).size !== artifacts.length) {
    throw new Error(`desktop update metadata: ${metadataFilename} names one artifact twice`)
  }
  const path = join(directory, metadataFilename)
  // `path` and `sha512` are the updater's fallback when it cannot pick from `files[]`; the newest
  // entry keeps them describing a payload this release actually carries.
  writeFileSync(path, dump({
    version,
    files: artifacts.map(artifact => channelFileEntry(artifact)),
    path: newest.filename,
    sha512: newest.sha512,
    releaseDate: new Date().toISOString(),
  }))
  return path
}
