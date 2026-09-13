/**
 * Reading a plugin bundle: one zip archive holding `manifest.json` and the
 * server it runs.
 *
 * Everything here treats the archive as untrusted input. A bundle is written
 * by whoever published it, so entry names are checked before any byte reaches
 * the filesystem, and two bounded budgets stop an archive that expands without
 * limit.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/bundle
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { unzipSync } from 'fflate'
import { PluginError } from './manifest.ts'

/** Most files one bundle may contain. */
export const MAX_BUNDLE_FILES = 20_000

/** Most bytes one bundle may expand to. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

/** Longest entry path a bundle may contain. */
export const MAX_ENTRY_PATH = 512

/** A parsed bundle: its files by relative POSIX path, and its manifest text. */
export interface BundleArchive {
  /** Entry contents, keyed by bundle-relative POSIX path. */
  entries: ReadonlyMap<string, Uint8Array>
  /** The raw `manifest.json` text. */
  manifest: string
}

/**
 * Decide whether one archive entry name may be written under the target
 * directory.
 *
 * Rejected outright: absolute names, names that traverse, Windows separators
 * (a single-entry name is a path, not a platform string), and names long enough
 * to be an attack rather than a file.
 * @param name - the entry name as the archive states it.
 * @returns true when the name is a relative path inside the bundle.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.length > MAX_ENTRY_PATH) return false
  if (name.startsWith('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  const normalized = posix.normalize(name)
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return false
  return !posix.isAbsolute(normalized)
}

/**
 * Open a bundle archive and validate its structure without touching disk.
 * @param bytes - the archive.
 * @returns the entry map and the manifest text.
 */
export function openBundle(bytes: Uint8Array): BundleArchive {
  let unpacked: Record<string, Uint8Array>
  try {
    unpacked = unzipSync(bytes)
  } catch (error: unknown) {
    throw new PluginError('bundle-invalid', 'this file is not a readable zip archive', { cause: error })
  }

  const entries = new Map<string, Uint8Array>()
  let totalBytes = 0
  for (const [name, content] of Object.entries(unpacked)) {
    if (name.endsWith('/')) continue
    if (!isSafeEntryName(name)) {
      throw new PluginError('bundle-invalid', `the archive contains an entry outside the bundle: ${name}`)
    }
    totalBytes += content.byteLength
    if (entries.size + 1 > MAX_BUNDLE_FILES) {
      throw new PluginError('bundle-invalid', `the archive holds more than ${String(MAX_BUNDLE_FILES)} files`)
    }
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new PluginError('bundle-invalid', 'the archive expands beyond the size this store accepts')
    }
    entries.set(name, content)
  }

  const manifestBytes = entries.get('manifest.json')
  if (manifestBytes === undefined) {
    throw new PluginError('bundle-invalid', 'the archive has no manifest.json at its root')
  }
  const manifest = new TextDecoder().decode(manifestBytes)
  try {
    JSON.parse(manifest)
  } catch (error: unknown) {
    throw new PluginError('manifest-invalid', 'manifest.json is not valid JSON', { cause: error })
  }
  return { entries, manifest }
}

/**
 * Write an opened bundle's files under `target`, replacing whatever is there.
 * @param archive - the opened bundle.
 * @param target - the directory to write into; created, and removed on failure.
 */
export function extractBundle(archive: BundleArchive, target: string): void {
  rmSync(target, { recursive: true, force: true })
  try {
    for (const [name, content] of archive.entries) {
      const path = join(target, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  } catch (error: unknown) {
    rmSync(target, { recursive: true, force: true })
    throw new PluginError('io-failed', `the bundle could not be written to ${target}`, { cause: error })
  }
}

/** Most bytes a downloaded bundle may hold before it is read into memory. */
export const MAX_BUNDLE_DOWNLOAD_BYTES = 128 * 1024 * 1024

/**
 * Download a bundle from an http(s) URL.
 * @param url - the absolute URL to fetch.
 * @returns the response body.
 */
export async function downloadBundle(url: string): Promise<Uint8Array> {
  if (!/^https?:\/\//.test(url)) {
    throw new PluginError('io-failed', 'a plugin URL must start with http:// or https://')
  }
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error: unknown) {
    throw new PluginError('io-failed', `could not reach ${url}`, { cause: error })
  }
  if (!response.ok) {
    throw new PluginError('io-failed', `${url} returned HTTP ${String(response.status)}`)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_BUNDLE_DOWNLOAD_BYTES) {
    throw new PluginError('io-failed', 'the download is larger than this store accepts')
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > MAX_BUNDLE_DOWNLOAD_BYTES) {
    throw new PluginError('io-failed', 'the download is larger than this store accepts')
  }
  return body
}
