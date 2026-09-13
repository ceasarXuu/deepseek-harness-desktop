/**
 * First-launch placement of the frozen runtime closure, and its integrity.
 *
 * The application ships the closure as one zstd-compressed tar archive inside
 * its own bundle. That archive is the only thing an installer carries: the tree
 * it expands to — seventeen thousand files, most of them dependencies — is
 * written once into the application's data directory, where it is an ordinary
 * package tree rather than an archive read through a virtual filesystem.
 *
 * Ordinary is the point. A real directory is what lets a plugin installed at
 * run time resolve the framework packages the host already has, spawn the
 * binaries it ships, and load its own native modules — all of which an archive
 * path cannot do.
 *
 * The tree lives outside the signed bundle, so it is not covered by the code
 * signature the way `app.asar` is. Two checks put it back under one: the
 * archive's digest is compared against the value the signed bundle records
 * before anything is expanded, and the expanded tree's own digest is compared
 * against the digest recorded when it was written. A tree that does not match
 * is not trusted and not repaired in place — it is expanded again from the
 * verified archive, which is what makes the check self-healing rather than a
 * wall the user has to get past.
 *
 * @module closure
 */

import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import * as tar from 'tar'

/** The archive the application ships, beside its other resources. */
export const CLOSURE_ARCHIVE = 'closure.tar.zst'

/** The file the signed bundle carries, holding the archive's digest. */
export const CLOSURE_ARCHIVE_DIGEST = 'closure.tar.zst.sha256'

/** The file whose presence marks a completed extraction. */
export const CLOSURE_MARKER = '.complete'

/** The directory under the harness home that holds every extracted version. */
const CLOSURE_DIRECTORY = 'closure'

/** Files read at once while digesting a tree; I/O latency dominates, not hashing. */
const DIGEST_CONCURRENCY = 16

/** What the marker records, so a tree that changed is detected rather than used. */
interface ClosureMarker {
  /** The archive this tree came from, as bytes. */
  archiveBytes: number
  /** The archive's digest, which the signed bundle also records. */
  archiveSha256: string
  /** The digest of the expanded tree, excluding this marker. */
  treeSha256: string
  /** How many files the archive expanded to. */
  files: number
  /** Binaries whose executable bit this step had to restore, if any. */
  restored: readonly string[]
}

/** How far a slow step has come, when it knows. */
export interface ClosureProgress {
  /** Entries handled so far. */
  done: number
  /** Entries the archive holds. */
  total: number
}

/** Where a closure comes from and where it goes. */
export interface EnsureClosureOptions {
  /** Absolute path of the shipped archive. */
  archive: string
  /** The harness home that receives the extracted tree. */
  home: string
  /** Version key for the directory name; one directory per shipped closure. */
  version: string
  /** Reports work that takes time, and nothing when there is none to do. */
  onProgress?: (message: string, progress?: ClosureProgress) => void
}

/** The directory one version occupies. */
function versionDirectory(home: string, version: string): string {
  return join(home, CLOSURE_DIRECTORY, version)
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
 * @param path - the file to read.
 * @returns the hex sha256 of its bytes.
 */
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Digest a directory tree.
 *
 * Per-file digests are combined in sorted order, so the result depends on the
 * paths and the contents and on nothing else — not on read order, and not on
 * when a file happened to be written.
 * @param root - the directory to digest.
 * @param exclude - a path to leave out, used for the marker that records the result.
 * @returns the hex sha256 of the tree.
 */
export async function treeDigest(root: string, exclude?: string): Promise<string> {
  const files = (await collectFiles(root)).filter(path => path !== exclude)
  const parts = new Array<string>(files.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++
      if (at >= files.length) return
      const path = files[at]!
      parts[at] = `${path.slice(root.length)}:${await fileDigest(path)}`
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIGEST_CONCURRENCY, files.length) }, worker))
  return createHash('sha256').update(parts.sort().join('\n')).digest('hex')
}

/** What the signed bundle records about this archive. */
interface ArchiveReference {
  /** Hex sha256 of the archive. */
  sha256: string
  /** How many entries the archive holds, when the reference states it. */
  entries?: number
}

/** The digest the signed bundle records for this archive. */
function archiveReference(archive: string): ArchiveReference {
  const reference = `${archive}.sha256`
  if (!existsSync(reference)) {
    throw new Error(`the application's closure digest is missing at ${reference}`)
  }
  const [recorded = '', entries] = readFileSync(reference, 'utf8').trim().split(/\s+/)
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    throw new Error(`the application's closure digest at ${reference} is not a sha256`)
  }
  const total = Number.parseInt(entries ?? '', 10)
  return { sha256: recorded, ...(Number.isSafeInteger(total) && total > 0 ? { entries: total } : {}) }
}

/** Read a version's marker, or undefined when it cannot be trusted to describe the tree. */
function readMarker(home: string, version: string): ClosureMarker | undefined {
  const path = join(versionDirectory(home, version), CLOSURE_MARKER)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClosureMarker
  } catch {
    // An unreadable marker is treated as absent: re-expanding is cheap next to
    // starting from a tree that may be half-written.
    return undefined
  }
}

/**
 * Whether the tree in place is the one the verified archive expands to.
 * @param options - the archive, home, and version.
 * @returns true when the recorded digests match what is on disk.
 */
async function treeVerified(options: EnsureClosureOptions, archiveSha256: string): Promise<boolean> {
  const marker = readMarker(options.home, options.version)
  if (marker === undefined || marker.archiveSha256 !== archiveSha256) return false
  const directory = versionDirectory(options.home, options.version)
  const digest = await treeDigest(directory, join(directory, CLOSURE_MARKER))
  return digest === marker.treeSha256
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
 * Expand the archive when the version in place is not the tree it describes.
 *
 * Extraction is staged: the archive expands into a temporary sibling, the
 * executables are checked there, and only then is the tree renamed into its
 * final name. An interrupted or failed attempt therefore leaves nothing that a
 * later launch could mistake for a usable closure.
 * @param options - the archive, the home, and the version key.
 * @returns the absolute path of the verified closure.
 */
export async function ensureClosure(options: EnsureClosureOptions): Promise<string> {
  const reference = archiveReference(options.archive)
  if (!existsSync(options.archive)) {
    throw new Error(`the runtime closure archive is missing at ${options.archive}`)
  }
  const actual = await fileDigest(options.archive)
  if (actual !== reference.sha256) {
    throw new Error(
      `the runtime closure archive does not match the digest this application ships `
      + `(expected ${reference.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…); reinstall the application`,
    )
  }

  const target = versionDirectory(options.home, options.version)
  if (await treeVerified(options, actual)) {
    pruneOtherVersions(options.home, options.version)
    return target
  }

  const root = join(options.home, CLOSURE_DIRECTORY)
  mkdirSync(root, { recursive: true })
  const staging = join(root, `.tmp-${String(process.pid)}-${String(Date.now())}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  options.onProgress?.('expanding the runtime closure')
  let files = 0
  try {
    await pipeline(
      createReadStream(options.archive),
      createZstdDecompress(),
      tar.x({
        cwd: staging,
        // The archive is verified, but a path escaping the staging directory
        // would write outside the application's data; refuse rather than trust.
        preservePaths: false,
        strict: true,
        onentry: () => {
          files += 1
          // Every entry would be twenty thousand messages; the window only needs
          // enough to move a bar.
          if (files % 250 === 0 && reference.entries !== undefined) {
            options.onProgress?.('expanding the runtime closure', { done: files, total: reference.entries })
          }
        },
      }),
    )
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the runtime closure could not be expanded: ${error instanceof Error ? error.message : String(error)}`)
  }

  const restored = restoreExecutables(staging)
  if (restored.length > 0) options.onProgress?.(`restored the executable bit on ${String(restored.length)} file(s)`)
  const treeSha256 = await treeDigest(staging)
  const marker: ClosureMarker = {
    archiveBytes: statSync(options.archive).size,
    archiveSha256: actual,
    treeSha256,
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
