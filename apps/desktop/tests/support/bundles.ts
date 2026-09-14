/**
 * Test support: building the MCP bundle archives the Desktop installer reads.
 *
 * A bundle is a zip holding `manifest.json`, the server, and that server's own
 * `node_modules`. These builders write the manifest the tests vary and carry
 * the dependency-free fixture server, so an install exercises a real archive
 * rather than a hand-written directory.
 */

import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

/** One file inside a bundle: its bundle-relative path and contents. */
export interface BundleFile {
  /** Path relative to the bundle root, POSIX separators. */
  readonly name: string
  /** The file's contents. */
  readonly content: string | Uint8Array
}

/** The bundle-relative path of the fixture server. */
export const FIXTURE_ENTRY = 'server/index.mjs'

/**
 * Build a bundle archive from explicit files and a manifest.
 * @param manifest - the `manifest.json` object.
 * @param files - every other file the bundle carries.
 * @returns the archive.
 */
export function makeBundle(manifest: unknown, files: readonly BundleFile[] = []): Uint8Array {
  return zipArchive(`${JSON.stringify(manifest, undefined, 2)}\n`, files)
}

/**
 * Build a bundle archive from raw manifest text, for the cases a manifest
 * object cannot express.
 * @param manifest - the `manifest.json` text.
 * @param files - every other file the bundle carries.
 * @returns the archive.
 */
export function archiveFromManifestText(manifest: string, files: readonly BundleFile[] = []): Uint8Array {
  return zipArchive(manifest, files)
}

function zipArchive(manifest: string, files: readonly BundleFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = { 'manifest.json': strToU8(manifest) }
  for (const file of files) {
    entries[file.name] = typeof file.content === 'string' ? strToU8(file.content) : file.content
  }
  return zipSync(entries)
}

/**
 * A minimal valid bundle manifest, with per-case overrides applied on top.
 * @param overrides - top-level manifest fields to replace.
 * @returns the manifest object.
 */
export function bundleManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: '0.3',
    name: 'demo',
    version: '1.0.0',
    description: 'A bundle used by the tests.',
    author: { name: 'Tester' },
    server: {
      type: 'node',
      entry_point: FIXTURE_ENTRY,
      mcp_config: { command: 'node', args: [`\${__dirname}/${FIXTURE_ENTRY}`] },
    },
    ...overrides,
  }
}

/**
 * The fixture server's source: a dependency-free stdio MCP server.
 * @returns the file's contents.
 */
export function fixtureServerSource(): string {
  return readFileSync(new URL('../fixtures/echo-server.mjs', import.meta.url), 'utf8')
}

/**
 * A complete bundle carrying the fixture server.
 * @param overrides - top-level manifest fields to replace.
 * @param files - extra files the bundle carries.
 * @returns the archive.
 */
export function echoBundle(overrides: Record<string, unknown> = {}, files: readonly BundleFile[] = []): Uint8Array {
  return makeBundle(bundleManifest(overrides), [{ name: FIXTURE_ENTRY, content: fixtureServerSource() }, ...files])
}
