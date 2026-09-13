/**
 * First-launch placement of the frozen runtime closure.
 *
 * The application ships the closure as one zstd-compressed tar archive inside
 * its own bundle. That archive is the only thing an installer carries: the
 * tree it expands to — seventeen thousand files, most of them dependencies —
 * is written once into the application's data directory, where it is an
 * ordinary package tree rather than an archive read through a virtual
 * filesystem.
 *
 * Ordinary is the point. A real directory is what lets a plugin installed at
 * run time resolve the framework packages the host already has, spawn the
 * binaries it ships, and load its own native modules — all of which an archive
 * path cannot do.
 *
 * @module closure
 */

import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import * as tar from 'tar'

/** The archive the application ships, beside its other resources. */
export const CLOSURE_ARCHIVE = 'closure.tar.zst'

/** The file whose presence marks a completed extraction. */
export const CLOSURE_MARKER = '.complete'

/** The directory under the harness home that holds every extracted version. */
const CLOSURE_DIRECTORY = 'closure'

/** What the marker records, so a stale extraction is detected rather than used. */
interface ClosureMarker {
  /** The archive this tree came from, as bytes. */
  archiveBytes: number
  /** The archive's modification time, in milliseconds. */
  archiveMtimeMs: number
  /** How many files the archive expanded to. */
  files: number
  /** Binaries whose executable bit this step had to restore, if any. */
  restored: readonly string[]
}

/** Where a closure comes from and where it goes. */
export interface EnsureClosureOptions {
  /** Absolute path of the shipped archive. */
  archive: string
  /** The harness home that receives the extracted tree. */
  home: string
  /** Version key for the directory name; one directory per shipped closure. */
  version: string
  /** Reports each step, for a window that is already on screen. */
  onProgress?: (message: string) => void
}

/** The directory one version occupies. */
function versionDirectory(home: string, version: string): string {
  return join(home, CLOSURE_DIRECTORY, version)
}

/** The marker path inside one version directory. */
function markerPath(home: string, version: string): string {
  return join(versionDirectory(home, version), CLOSURE_MARKER)
}

/**
 * Whether a completed extraction for this archive is already in place.
 * @param options - the same inputs {@link ensureClosure} takes.
 * @returns true when the marker matches the archive on disk.
 */
export function closureReady(options: EnsureClosureOptions): boolean {
  const marker = markerPath(options.home, options.version)
  if (!existsSync(marker)) return false
  try {
    const recorded = JSON.parse(readFileSync(marker, 'utf8')) as ClosureMarker
    const stats = statSync(options.archive)
    return recorded.archiveBytes === stats.size && recorded.archiveMtimeMs === Math.trunc(stats.mtimeMs)
  } catch {
    // An unreadable marker is treated as absent: re-extracting is cheap next to
    // starting from a tree that may be half-written.
    return false
  }
}

/**
 * Restore the executable bit on the binaries the closure spawns.
 *
 * A tar preserves modes, so this normally finds nothing. It exists because the
 * failure it prevents is remote from its cause: without the bit, a search tool
 * reports a launch failure and a terminal reports `posix_spawnp failed`, and
 * neither message names a file mode.
 * @param root - the extracted tree.
 * @returns the paths whose bit was restored.
 */
function restoreExecutables(root: string): string[] {
  const restored: string[] = []
  const consider = (relative: string): void => {
    const path = join(root, relative)
    if (!existsSync(path)) return
    if ((statSync(path).mode & 0o111) !== 0) return
    chmodSync(path, 0o755)
    restored.push(relative)
  }
  const vscode = join(root, 'node_modules/@vscode')
  if (existsSync(vscode)) {
    for (const entry of readdirSync(vscode)) {
      if (entry.startsWith('ripgrep-')) consider(`node_modules/@vscode/${entry}/bin/rg`)
    }
  }
  const prebuilds = join(root, 'node_modules/node-pty/prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) consider(`node_modules/node-pty/prebuilds/${entry}/spawn-helper`)
  }
  return restored
}

/** Remove every extraction except the one being kept, and any interrupted attempt. */
function pruneOtherVersions(home: string, keep: string): void {
  const root = join(home, CLOSURE_DIRECTORY)
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    if (entry === keep) continue
    rmSync(join(root, entry), { recursive: true, force: true })
  }
}

/**
 * Expand the shipped archive if this version is not already in place.
 *
 * Extraction is staged: the archive expands into a temporary sibling, the
 * executables are checked there, and only then is the tree renamed into its
 * final name. An interrupted or failed attempt therefore leaves nothing that a
 * later launch could mistake for a usable closure.
 * @param options - the archive, the home, and the version key.
 * @returns the absolute path of the extracted closure.
 */
export async function ensureClosure(options: EnsureClosureOptions): Promise<string> {
  const target = versionDirectory(options.home, options.version)
  if (closureReady(options)) {
    pruneOtherVersions(options.home, options.version)
    return target
  }
  if (!existsSync(options.archive)) {
    throw new Error(`the runtime closure archive is missing at ${options.archive}`)
  }

  const root = join(options.home, CLOSURE_DIRECTORY)
  mkdirSync(root, { recursive: true })
  const staging = join(root, `.tmp-${String(process.pid)}-${String(Date.now())}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  options.onProgress?.('unpacking the runtime closure')
  let files = 0
  try {
    await pipeline(
      createReadStream(options.archive),
      createZstdDecompress(),
      tar.x({
        cwd: staging,
        // The archive is ours, but a path escaping the staging directory would
        // write outside the application's data; refuse rather than trust.
        preservePaths: false,
        strict: true,
        onentry: () => { files += 1 },
      }),
    )
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the runtime closure could not be unpacked: ${error instanceof Error ? error.message : String(error)}`)
  }

  const restored = restoreExecutables(staging)
  if (restored.length > 0) options.onProgress?.(`restored the executable bit on ${String(restored.length)} file(s)`)

  const stats = statSync(options.archive)
  const marker: ClosureMarker = {
    archiveBytes: stats.size,
    archiveMtimeMs: Math.trunc(stats.mtimeMs),
    files,
    restored,
  }
  writeFileSync(join(staging, CLOSURE_MARKER), `${JSON.stringify(marker, null, 2)}\n`)

  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  pruneOtherVersions(options.home, options.version)
  options.onProgress?.(`runtime closure ready (${String(files)} files)`)
  return target
}
