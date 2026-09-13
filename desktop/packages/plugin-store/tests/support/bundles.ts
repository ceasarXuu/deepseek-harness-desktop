/**
 * Test support: building plugin bundles.
 *
 * Two builders, because the store's tests need both ends of the same claim.
 * {@link makeBundle} writes a bundle from explicit files, which is how the
 * hermetic fixture server is packaged. {@link packInstalledPackage} writes one
 * from a package that is already installed in this repository, copying its
 * whole dependency closure — the same thing a third-party author does with
 * `npm install --production` before zipping, and the only way to test an
 * EXTERNAL plugin without reaching the network.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

/** One file inside a bundle: its bundle-relative path and contents. */
export interface BundleFile {
  /** Path relative to the bundle root, POSIX separators. */
  name: string
  /** The file's contents. */
  content: string | Uint8Array
}

/**
 * Build a bundle archive from explicit files and a manifest.
 * @param manifest - the `manifest.json` object.
 * @param files - every other file the bundle carries.
 * @returns the archive.
 */
export function makeBundle(manifest: unknown, files: readonly BundleFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  }
  for (const file of files) {
    entries[file.name] = typeof file.content === 'string' ? strToU8(file.content) : file.content
  }
  return zipSync(entries)
}

/** Most bytes one file may contribute to a packed package. */
const MAX_PACKED_FILE_BYTES = 4 * 1024 * 1024

/**
 * Resolve a package's directory by walking `node_modules` upward from a start
 * directory, the way Node itself does.
 * @param from - the directory to start at.
 * @param name - the package name, optionally scoped.
 * @returns the package directory, or undefined when it is not installed.
 */
function resolvePackageDir(from: string, name: string): string | undefined {
  let directory = from
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      // Real location, not the link: a package manager's link farm puts a
      // dependency's own dependencies beside the package's real directory, so
      // walking up from the link would look in the wrong tree entirely.
      return realpathSync(candidate)
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Every package in a package's dependency closure, by name. */
function dependencyClosure(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()!
    let manifest: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(declared)) {
      if (found.has(name)) continue
      const resolved = resolvePackageDir(directory, name)
      if (resolved === undefined) continue
      found.set(name, resolved)
      queue.push(resolved)
    }
  }
  return found
}

/** Add one directory tree to a bundle file list, skipping nested installs. */
function addTree(files: BundleFile[], prefix: string, directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      addTree(files, `${prefix}/${entry.name}`, path)
      continue
    }
    if (!entry.isFile()) continue
    if (statSync(path).size > MAX_PACKED_FILE_BYTES) continue
    files.push({ name: `${prefix}/${entry.name}`, content: new Uint8Array(readFileSync(path)) })
  }
}

/**
 * Pack an installed package and its dependency closure into a bundle.
 *
 * The result is self-contained in the way a published bundle must be: the
 * server's own `node_modules` travels with it, so the host needs no package
 * manager and the machine needs no network.
 * @param packageDir - the installed package's directory.
 * @param relativeEntry - the entry point's path relative to the package.
 * @param serverArgs - arguments the server needs after its entry point.
 * @param overrides - manifest fields to override the package's own.
 * @returns the archive, or undefined when the package is not installed.
 */
export function packInstalledPackage(
  packageDir: string,
  relativeEntry: string,
  serverArgs: readonly string[] = [],
  overrides: Record<string, unknown> = {},
): Uint8Array | undefined {
  if (!existsSync(join(packageDir, 'package.json'))) return undefined
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    description?: string
    author?: unknown
  }
  const files: BundleFile[] = []
  addTree(files, 'server', packageDir)
  for (const [name, directory] of dependencyClosure(packageDir)) {
    addTree(files, `node_modules/${name}`, directory)
  }
  return makeBundle({
    manifest_version: '0.3',
    name: manifest.name ?? 'packed-package',
    version: manifest.version ?? '0.0.0',
    description: manifest.description ?? 'A packaged MCP server.',
    author: manifest.author ?? { name: 'fixture' },
    server: {
      type: 'node',
      entry_point: `server/${relativeEntry}`,
      mcp_config: { command: 'node', args: ['${__dirname}/server/' + relativeEntry, ...serverArgs] },
    },
    ...overrides,
  }, files)
}

/**
 * The path of the dependency-free fixture server's source file.
 * @returns the absolute path.
 */
export function fixtureServerPath(): string {
  return join(dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'echo-server.mjs')
}
