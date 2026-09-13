/**
 * First-launch expansion of the bundled runtime archive, and its integrity.
 *
 * The application ships its runtime as one zstd-compressed tar inside its own bundle and expands
 * that archive once into the Harness home, where it is an ordinary package tree. A real directory
 * is what lets an external plugin resolve the framework packages the runtime already has, spawn
 * the executables it ships, and load its own native modules.
 *
 * The expanded tree lives outside the signed bundle, so two digests put it back under the
 * signature: the archive is compared against the value the bundle carries before anything is
 * expanded, and the expanded tree is compared against the digest recorded when it was written. A
 * tree that does not match is expanded again from the verified archive rather than repaired.
 *
 * The packaging step writes the format this module reads: `packRuntimeArchive` feeds
 * `ensureDesktopRuntime`, so the writer and the reader change together.
 *
 * @module runtime-closure
 */

import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import * as tar from 'tar'

/** The archive the application carries beside its other resources. */
export const DESKTOP_RUNTIME_ARCHIVE = 'desktop-runtime.tar.zst'

/** The file the signed bundle carries, holding the archive's digest and entry count. */
export const DESKTOP_RUNTIME_ARCHIVE_DIGEST = 'desktop-runtime.tar.zst.sha256'

/** The file whose presence marks an expansion that finished. */
export const DESKTOP_RUNTIME_MARKER = '.complete'

/** Files hashed at once while digesting a tree; latency dominates, not hashing. */
const DIGEST_CONCURRENCY = 16

/** Entries between two progress reports; the window only needs enough to move a bar. */
const PROGRESS_INTERVAL = 250

/** Work a first launch performs before the runtime can start, and how far it has come. */
export interface DesktopRuntimeProgress {
  /** What the launch is doing. */
  readonly stage: 'expanding' | 'verifying'
  /** Entries handled so far. */
  readonly done: number
  /** Entries the stage will handle; zero when no count is available. */
  readonly total: number
}

/** What the marker records, so a tree that changed is detected rather than used. */
interface RuntimeMarker {
  /** The archive this tree came from, as bytes. */
  archiveBytes: number
  /** The archive's digest, which the signed bundle also records. */
  archiveSha256: string
  /** The digest of the expanded tree, excluding this marker. */
  treeSha256: string
  /** How many entries the archive expanded to. */
  files: number
  /** Executables whose executable bit the expansion had to restore. */
  restored: readonly string[]
}

/** Where the archive comes from, where it goes, and how far the work has come. */
export interface EnsureDesktopRuntimeOptions {
  /** Absolute path of the shipped archive. */
  readonly archive: string
  /** Directory holding one subdirectory per shipped runtime version. */
  readonly home: string
  /** Version key for the directory name; one directory per shipped runtime. */
  readonly version: string
  /** Receives work that takes time, and nothing when there is none to do. */
  readonly onProgress?: (progress: DesktopRuntimeProgress) => void
}

/** What the packaging step produced, and what the expansion has to reproduce. */
export interface DesktopRuntimeArchiveRecord {
  /** Entries in the archive; the progress denominator on the first launch. */
  readonly entries: number
  /** Archive size in bytes, recorded so a replacement is visible. */
  readonly bytes: number
  /** Hex sha256 of the archive. */
  readonly archiveSha256: string
  /** Hex sha256 of the tree the archive holds, before it was packed. */
  readonly treeSha256: string
}

/** The digest the signed bundle records for one archive. */
interface ArchiveReference {
  /** Hex sha256 of the archive. */
  readonly sha256: string
  /** How many entries the archive holds, when the reference states it. */
  readonly entries: number | undefined
}

/** The directory one version occupies. */
function versionDirectory(home: string, version: string): string {
  return join(home, version)
}

/** Collect every file under a directory, depth first. */
async function collectFiles(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/**
 * Digest a file's contents.
 * @param path - File to read.
 * @returns Hex sha256 of its bytes.
 */
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Digest a directory tree.
 *
 * Per-file digests are combined in sorted order, so the result depends on the paths and the
 * contents and on nothing else — not on read order, and not on when a file was written.
 * @param root - Directory to digest.
 * @param exclude - Path to leave out, used for the marker that records the result.
 * @returns Hex sha256 of the tree.
 */
export async function treeDigest(root: string, exclude?: string): Promise<string> {
  const files = (await collectFiles(root)).filter(path => path !== exclude)
  const parts = new Array<string>(files.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++
      const path = files[at]
      if (path === undefined) return
      parts[at] = `${path.slice(root.length)}:${await fileDigest(path)}`
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIGEST_CONCURRENCY, files.length) }, worker))
  return createHash('sha256').update(parts.sort().join('\n')).digest('hex')
}

/** The failure a mismatched archive reports, so a wrong installation names one remedy. */
function mismatchError(expected: string, actual: string): Error {
  return new Error(
    'the runtime archive does not match the digest this application ships '
    + `(expected ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}…); reinstall the application`,
  )
}

/**
 * Read the digest the signed bundle records for one archive.
 * @param archive - Archive the bundle carries.
 * @returns Recorded digest and entry count.
 */
function archiveReference(archive: string): ArchiveReference {
  const reference = `${archive}.sha256`
  if (!existsSync(reference)) {
    throw new Error(`the application's runtime digest is missing at ${reference}`)
  }
  const [recorded = '', entries] = readFileSync(reference, 'utf8').trim().split(/\s+/)
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    throw new Error(`the application's runtime digest at ${reference} is not a sha256`)
  }
  const total = Number.parseInt(entries ?? '', 10)
  return { sha256: recorded, entries: Number.isSafeInteger(total) && total > 0 ? total : undefined }
}

/**
 * Compare one archive against the digest the bundle records for it.
 * @param archive - Archive the application carries.
 * @returns Hex sha256 of the verified archive.
 */
export async function verifyRuntimeArchive(archive: string): Promise<string> {
  const reference = archiveReference(archive)
  const actual = await fileDigest(archive)
  if (actual !== reference.sha256) throw mismatchError(reference.sha256, actual)
  return actual
}

/**
 * Read a version's marker, or undefined when it cannot be trusted to describe the tree.
 * @param home - Directory holding one subdirectory per version.
 * @param version - Version key of the expansion.
 * @returns The recorded marker, or undefined when it is absent or unreadable.
 */
function readMarker(home: string, version: string): RuntimeMarker | undefined {
  const path = join(versionDirectory(home, version), DESKTOP_RUNTIME_MARKER)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeMarker
  } catch {
    // An unreadable marker counts as absent: expanding again is cheap next to
    // starting from a tree that may be half-written.
    return undefined
  }
}

/**
 * Whether the tree in place is the one the verified archive expands to.
 * @param options - The archive, home, and version.
 * @param archiveSha256 - Digest of the archive that is about to be expanded.
 * @returns True when the digests recorded for the tree match what is on disk.
 */
async function treeVerified(options: EnsureDesktopRuntimeOptions, archiveSha256: string): Promise<boolean> {
  const marker = readMarker(options.home, options.version)
  if (marker === undefined || marker.archiveSha256 !== archiveSha256) return false
  const directory = versionDirectory(options.home, options.version)
  options.onProgress?.({ stage: 'verifying', done: 0, total: 0 })
  return await treeDigest(directory, join(directory, DESKTOP_RUNTIME_MARKER)) === marker.treeSha256
}

/**
 * Restore the executable bit on the binaries the runtime spawns.
 *
 * A tar preserves modes, so this normally finds nothing. It exists because the failure it prevents
 * is remote from its cause: without the bit, a search tool reports a launch failure and a terminal
 * reports `posix_spawnp failed`, and neither message names a file mode.
 * @param root - Expanded tree.
 * @returns Paths whose bit this step restored, relative to the tree.
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

/** Remove every expansion except the one being kept, and any interrupted attempt. */
function pruneOtherVersions(home: string, keep: string): void {
  if (!existsSync(home)) return
  for (const entry of readdirSync(home)) {
    if (entry === keep) continue
    rmSync(join(home, entry), { recursive: true, force: true })
  }
}

/**
 * Expand the verified archive into a staging directory.
 * @param options - The archive and the progress sink.
 * @param reference - Digest and entry count the bundle records.
 * @param staging - Empty directory that receives the tree.
 * @returns Expanded entry count and the executables whose bit was restored.
 */
async function expandArchive(
  options: EnsureDesktopRuntimeOptions, reference: ArchiveReference, staging: string,
): Promise<{ files: number; restored: readonly string[] }> {
  const total = reference.entries ?? 0
  options.onProgress?.({ stage: 'expanding', done: 0, total })
  let files = 0
  try {
    await pipeline(
      createReadStream(options.archive),
      createZstdDecompress(),
      tar.x({
        cwd: staging,
        // The archive is verified, but a path escaping the staging directory would
        // write outside the Harness home; refuse rather than trust.
        preservePaths: false,
        strict: true,
        onReadEntry: () => {
          files += 1
          // Every entry would be twenty thousand messages; the window only needs
          // enough to move a bar.
          if (files % PROGRESS_INTERVAL === 0) {
            options.onProgress?.({ stage: 'expanding', done: files, total })
          }
        },
      }),
    )
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the desktop runtime could not be expanded: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { files, restored: restoreExecutables(staging) }
}

/**
 * Expand the archive when the version in place is not the tree it describes.
 *
 * Expansion is staged: the archive expands into a temporary sibling and only then is renamed into
 * its final name, so an interrupted attempt leaves nothing a later launch could mistake for a
 * usable runtime.
 * @param options - The archive, the home, the version key, and an optional progress sink.
 * @returns Absolute path of the verified runtime tree.
 */
export async function ensureDesktopRuntime(options: EnsureDesktopRuntimeOptions): Promise<string> {
  if (!existsSync(options.archive)) {
    throw new Error(`the desktop runtime archive is missing at ${options.archive}`)
  }
  const reference = archiveReference(options.archive)
  const actual = await fileDigest(options.archive)
  if (actual !== reference.sha256) throw mismatchError(reference.sha256, actual)

  const target = versionDirectory(options.home, options.version)
  if (await treeVerified(options, actual)) {
    pruneOtherVersions(options.home, options.version)
    return target
  }

  mkdirSync(options.home, { recursive: true })
  const staging = join(options.home, `.tmp-${String(process.pid)}-${String(Date.now())}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const { files, restored } = await expandArchive(options, reference, staging)

  options.onProgress?.({ stage: 'verifying', done: 0, total: 0 })
  const marker: RuntimeMarker = {
    archiveBytes: statSync(options.archive).size,
    archiveSha256: actual,
    treeSha256: await treeDigest(staging),
    files,
    restored,
  }
  writeFileSync(join(staging, DESKTOP_RUNTIME_MARKER), `${JSON.stringify(marker, undefined, 2)}\n`)

  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  pruneOtherVersions(options.home, options.version)
  return target
}

/**
 * Pack a prepared runtime tree into the one archive the application carries.
 *
 * The archive preserves POSIX modes because the executables inside it (ripgrep, node-pty's
 * spawn-helper) stop being runnable the moment an archive stops preserving them.
 * @param tree - Prepared runtime directory, descriptor included.
 * @param archive - Archive path to write, beside which the digest is written.
 * @returns What the expansion has to reproduce.
 */
export async function packRuntimeArchive(tree: string, archive: string): Promise<DesktopRuntimeArchiveRecord> {
  const treeSha256 = await treeDigest(tree)
  let entries = 0
  await pipeline(
    tar.c({
      cwd: tree,
      // Absolute paths, ownership, and the source machine's times are noise for a
      // tree that is expanded into a fresh location on the user's machine. Entry
      // modes stay, because they decide whether the runtime's own executables run.
      portable: true,
      // The filter sees every path that would enter the archive; counting here
      // reports the same number the extractor will count on the other side.
      filter: () => { entries += 1; return true },
    }, ['.']),
    createZstdCompress(),
    createWriteStream(archive),
  )
  const bytes = statSync(archive).size
  const archiveSha256 = await fileDigest(archive)
  // The digest travels beside the archive inside the signed bundle, which is what makes it a
  // trustworthy reference: the application compares the archive it is about to expand against this
  // value, and the expansion against the digest recorded when it was written. The entry count
  // rides in the same `sha256sum`-style line, so the first launch can show determinate progress.
  writeFileSync(`${archive}.sha256`, `${archiveSha256}  ${String(entries)}\n`)
  return { entries, bytes, archiveSha256, treeSha256 }
}
