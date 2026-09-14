/**
 * MCP bundles: unpacking a `.mcpb` archive and generating the desktop plugin
 * that mounts the server it carries.
 *
 * A bundle is written by whoever published it, so the archive and its manifest
 * are untrusted input: every entry name is checked before a byte reaches the
 * filesystem, two bounded budgets stop an archive that expands without limit,
 * and the manifest must name a server kind this host can run.
 *
 * One install produces two halves. The payload — the bundle's own files — lands
 * at `$DSH_HOME/plugins/<id>/<version>/`, which is outside the signed
 * application and outside the profile. The generated plugin lands at
 * `<profile>/plugins/<id>`: a package whose only job is to carry the patch that
 * mounts `@deepseek-ai/dsh-mcp-client` against that payload, run with the
 * application's own binary re-entered as Node. The profile records it as the
 * `file:./plugins/<id>` dependency, so the application's ordinary plugin
 * transaction installs, lists, and removes it.
 *
 * Everything here is filesystem and parsing work: no Cordis, no profile, no
 * live mount.
 *
 * @module @deepseek-ai/dsh-desktop/mcp-bundles
 */

import {
  accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'

/** Why an install or a removal was refused. */
export type McpBundleErrorCode =
  | 'bundle-invalid'
  | 'manifest-invalid'
  | 'server-unsupported'
  | 'incompatible'
  | 'user-config-required'
  | 'not-found'
  | 'io-failed'

/** A bundle failure a person can act on; `message` is written for the panel. */
export class McpBundleError extends Error {
  /** Stable code for callers that branch without parsing text. */
  readonly code: McpBundleErrorCode

  /**
   * @param code - why the operation failed.
   * @param message - the reason, written for the interface.
   * @param options - the underlying cause, when one exists.
   */
  constructor(code: McpBundleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Most files one bundle may contain. */
export const MAX_BUNDLE_FILES = 20_000

/** Most bytes one bundle may expand to. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

/** Longest entry path a bundle may contain. */
export const MAX_ENTRY_PATH = 512

/** Most bytes a downloaded bundle may hold before it is read into memory. */
export const MAX_BUNDLE_DOWNLOAD_BYTES = 128 * 1024 * 1024

/** The registry file's name inside the plugin directory. */
export const REGISTRY_FILENAME = 'installed.json'

/** The generated plugin's patch file name. */
export const PLUGIN_PATCH_FILENAME = 'cordis.patch.yml'

/** The `mcp-client` package every generated patch mounts, and the host peer each plugin names. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** The registry format this version writes. */
const REGISTRY_FORMAT = 1

/** The server kinds this host can launch. */
export type SupportedServerType = 'node' | 'binary'

/** The shape `serverName` must take for `mcp-client` to accept it. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Characters a bundle id may contain after normalization. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A parsed bundle: its files by relative POSIX path, and its manifest text. */
export interface BundleArchive {
  /** Entry contents, keyed by bundle-relative POSIX path. */
  readonly entries: ReadonlyMap<string, Uint8Array>
  /** The raw `manifest.json` text. */
  readonly manifest: string
}

/**
 * Decide whether one archive entry name may be written under the target
 * directory.
 *
 * Rejected outright: absolute names, names that traverse, Windows separators
 * (a single entry name is a path, not a platform string), NUL bytes, and names
 * long enough to be an attack rather than a file.
 * @param name - the entry name as the archive states it.
 * @returns true when the name is a relative path inside the bundle.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.length > MAX_ENTRY_PATH) return false
  if (name.startsWith('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  const normalized = posix.normalize(name)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return false
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
    throw new McpBundleError('bundle-invalid', 'this file is not a readable zip archive', { cause: error })
  }

  const entries = new Map<string, Uint8Array>()
  let totalBytes = 0
  for (const [name, content] of Object.entries(unpacked)) {
    if (name.endsWith('/')) continue
    if (!isSafeEntryName(name)) {
      throw new McpBundleError('bundle-invalid', `the archive contains an entry outside the bundle: ${name}`)
    }
    totalBytes += content.byteLength
    if (entries.size + 1 > MAX_BUNDLE_FILES) {
      throw new McpBundleError('bundle-invalid', `the archive holds more than ${String(MAX_BUNDLE_FILES)} files`)
    }
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new McpBundleError('bundle-invalid', 'the archive expands beyond the size this application accepts')
    }
    entries.set(name, content)
  }

  const manifestBytes = entries.get('manifest.json')
  if (manifestBytes === undefined) {
    throw new McpBundleError('bundle-invalid', 'the archive has no manifest.json at its root')
  }
  const manifest = new TextDecoder().decode(manifestBytes)
  try {
    JSON.parse(manifest)
  } catch (error: unknown) {
    throw new McpBundleError('manifest-invalid', 'manifest.json is not valid JSON', { cause: error })
  }
  return { entries, manifest }
}

/**
 * Download a bundle from an http(s) URL.
 * @param url - the absolute URL to fetch.
 * @returns the response body.
 */
export async function downloadBundle(url: string): Promise<Uint8Array> {
  if (!/^https?:\/\//u.test(url)) {
    throw new McpBundleError('io-failed', 'a bundle URL must start with http:// or https://')
  }
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error: unknown) {
    throw new McpBundleError('io-failed', `could not reach ${url}`, { cause: error })
  }
  if (!response.ok) {
    throw new McpBundleError('io-failed', `${url} returned HTTP ${String(response.status)}`)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_BUNDLE_DOWNLOAD_BYTES) {
    throw new McpBundleError('io-failed', 'the download is larger than this application accepts')
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > MAX_BUNDLE_DOWNLOAD_BYTES) {
    throw new McpBundleError('io-failed', 'the download is larger than this application accepts')
  }
  return body
}

/** The values `${...}` placeholders resolve against. */
export interface SubstitutionVariables {
  /** Absolute path of the installed bundle's own version directory. */
  readonly dirname: string
  /** The invoking user's home directory. */
  readonly home: string
}

/** Directory names under `$HOME` the specification lets a manifest reference. */
const HOME_SUBDIRECTORIES: Readonly<Record<string, string>> = {
  DESKTOP: 'Desktop',
  DOCUMENTS: 'Documents',
  DOWNLOADS: 'Downloads',
}

/**
 * Replace the placeholders the MCP Bundle specification defines.
 *
 * `user_config.*` is not substituted: a bundle that needs it is refused at
 * validation, because a value this application cannot collect would silently
 * reach the server as an empty string.
 * @param text - one argument or environment value.
 * @param variables - the installation's resolved paths.
 * @returns the text with every supported placeholder replaced.
 */
export function substituteVariables(text: string, variables: SubstitutionVariables): string {
  return text.replace(/\$\{([^}]*)\}/gu, (match, key: string) => {
    if (key === '__dirname') return variables.dirname
    if (key === 'HOME') return variables.home
    if (key === 'pathSeparator' || key === '/') return '/'
    const subdirectory = HOME_SUBDIRECTORIES[key]
    if (subdirectory !== undefined) return `${variables.home}/${subdirectory}`
    return match
  })
}

/**
 * Normalize a manifest name into the install identity.
 * @param name - the manifest's machine-readable name.
 * @returns a lowercase, dash-separated id.
 */
export function toPluginId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  if (!ID_PATTERN.test(id)) {
    throw new McpBundleError('manifest-invalid', `manifest name ${JSON.stringify(name)} does not yield a usable bundle id`)
  }
  return id
}

/**
 * Derive the MCP server namespace for one bundle.
 *
 * `mcp-client` requires `[A-Za-z0-9_-]{1,32}` and refuses duplicates at load,
 * so the id is truncated with a short digest of the whole id appended: two ids
 * that share a prefix still get distinct namespaces.
 * @param id - the bundle's install identity.
 * @returns a stable server namespace.
 */
export function toServerName(id: string): string {
  const slug = id.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24)
  let digest = 5381
  for (const character of id) digest = ((digest * 33) ^ (character.codePointAt(0) ?? 0)) >>> 0
  const name = `${slug === '' ? 'bundle' : slug}-${digest.toString(16).slice(0, 6)}`
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new McpBundleError('manifest-invalid', `bundle id ${JSON.stringify(id)} has no usable server name`)
  }
  return name
}

/**
 * The npm package name of the plugin generated for one bundle id.
 * @param id - the bundle's install identity.
 * @returns the generated plugin's package name.
 */
export function bundlePluginPackageName(id: string): string {
  return `dsh-mcp-bundle-${id}`
}

/**
 * The profile-relative dependency spec one generated plugin is recorded as.
 * @param id - the bundle's install identity.
 * @returns the `file:` spec the profile manifest holds.
 */
export function bundlePluginSpec(id: string): string {
  return `file:./plugins/${id}`
}

/** What a validated manifest states, with every field this installer needs resolved. */
export interface ResolvedBundleManifest {
  /** Machine-readable name from the manifest, normalized into the install identity. */
  readonly id: string
  /** Human name for the interface. */
  readonly displayName: string
  /** The manifest's declared version. */
  readonly version: string
  /** One-line description. */
  readonly description: string
  /** Author name, possibly empty when the manifest names none usable. */
  readonly author: string
  /** Homepage, when the manifest names one. */
  readonly homepage?: string
  /** Which runtime the server needs. */
  readonly serverType: SupportedServerType
  /** Server entry point, relative to the bundle root. */
  readonly entryPoint: string
  /** The `mcp_config.command` the manifest declared, substituted. */
  readonly command?: string
  /** Extra argv elements from `mcp_config`, already substituted. */
  readonly args: readonly string[]
  /** Extra environment from `mcp_config`, already substituted. */
  readonly env: Readonly<Record<string, string>>
  /** Platforms the manifest declared. */
  readonly platforms: readonly string[]
  /** The declared Node runtime range, shown rather than enforced. */
  readonly nodeRange?: string
  /** The declared range for this application, shown rather than enforced. */
  readonly appRange?: string
}

/** The `server` block, before validation. */
interface RawServer {
  readonly type?: unknown
  readonly entry_point?: unknown
  readonly mcp_config?: unknown
}

/** Read the manifest's object field, or raise the manifest as invalid. */
function objectField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpBundleError('manifest-invalid', `manifest field ${JSON.stringify(field)} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Read the manifest's non-empty string field, or raise the manifest as invalid. */
function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpBundleError('manifest-invalid', `manifest field ${JSON.stringify(field)} must be a non-empty string`)
  }
  return value
}

/** The optional string field, or `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The author name, accepting both the documented object and the common bare string. */
function authorName(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>)['name']
    if (typeof name === 'string') return name
  }
  return ''
}

/**
 * Every `user_config` key a manifest needs filled in.
 * @param manifest - the parsed `manifest.json`.
 * @param server - the manifest's raw `server` block.
 * @returns the declared and referenced keys, deduplicated, in first-seen order.
 */
function requiredUserConfig(manifest: Record<string, unknown>, server: RawServer): string[] {
  const keys = new Set<string>()
  if (manifest['user_config'] !== undefined) {
    for (const key of Object.keys(objectField(manifest['user_config'], 'user_config'))) keys.add(key)
  }
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const found of value.matchAll(/\$\{user_config\.([^}]+)\}/gu)) {
        const key = found[1]
        if (key !== undefined) keys.add(key)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const entry of Object.values(value)) scan(entry)
    }
  }
  scan(server.mcp_config)
  return [...keys]
}

/**
 * Validate one `mcp_config` block and substitute its placeholders.
 * @param server - the manifest's raw `server` block.
 * @param variables - the installation's resolved paths.
 * @param platform - the platform whose override applies.
 * @returns the argv tail and environment the server is launched with.
 */
function resolveMcpConfig(
  server: RawServer,
  variables: SubstitutionVariables,
  platform: string,
): { command: string | undefined; args: readonly string[]; env: Readonly<Record<string, string>> } {
  const raw = server.mcp_config === undefined ? {} : objectField(server.mcp_config, 'server.mcp_config')
  const overrides = raw['platform_overrides'] === undefined
    ? {}
    : objectField(raw['platform_overrides'], 'server.mcp_config.platform_overrides')
  const override = overrides[platform] === undefined
    ? {}
    : objectField(overrides[platform], 'server.mcp_config.platform_overrides')
  const merged = { ...raw, ...override }

  const command = merged['command'] === undefined
    ? undefined
    : substituteVariables(stringField(merged['command'], 'server.mcp_config.command'), variables)

  const declaredArgs: unknown = merged['args'] === undefined ? [] : merged['args']
  if (!Array.isArray(declaredArgs) || declaredArgs.some((entry: unknown) => typeof entry !== 'string')) {
    throw new McpBundleError('manifest-invalid', 'manifest field "server.mcp_config.args" must be an array of strings')
  }
  const args: string[] = []
  for (const entry of declaredArgs as readonly string[]) args.push(substituteVariables(entry, variables))
  const env: Record<string, string> = {}
  if (merged['env'] !== undefined) {
    for (const [key, value] of Object.entries(objectField(merged['env'], 'server.mcp_config.env'))) {
      if (typeof value !== 'string') {
        throw new McpBundleError('manifest-invalid', `manifest field "server.mcp_config.env.${key}" must be a string`)
      }
      env[key] = substituteVariables(value, variables)
    }
  }
  return { command, args: args.map(entry => substituteVariables(entry, variables)), env }
}

/**
 * Validate a parsed `manifest.json` into the shape the installer acts on.
 *
 * Validation is structural plus the three facts that decide whether anything
 * can run at all: the server kind is one this host can launch, the entry point
 * is a path inside the bundle, and the bundle does not depend on configuration
 * this host cannot collect yet.
 * @param raw - the parsed manifest.
 * @param variables - the installation's resolved paths.
 * @param platform - the platform whose `platform_overrides` apply.
 * @returns the resolved manifest.
 */
export function parseBundleManifest(
  raw: unknown,
  variables: SubstitutionVariables,
  platform: string,
): ResolvedBundleManifest {
  const manifest = objectField(raw, 'manifest.json')
  stringField(manifest['manifest_version'], 'manifest_version')
  const id = toPluginId(stringField(manifest['name'], 'name'))
  const version = stringField(manifest['version'], 'version')
  const description = stringField(manifest['description'], 'description')
  if (manifest['author'] === undefined || authorName(manifest['author']) === '') {
    throw new McpBundleError('manifest-invalid', 'manifest field "author" is required')
  }

  const server: RawServer = objectField(manifest['server'], 'server')
  const type = stringField(server.type, 'server.type')
  if (type !== 'node' && type !== 'binary') {
    throw new McpBundleError(
      'server-unsupported',
      `this application runs "node" and "binary" bundles; this bundle declares "${type}"`,
    )
  }
  const entryPoint = stringField(server.entry_point, 'server.entry_point')
  if (isAbsolute(entryPoint) || entryPoint.includes('\\') || entryPoint.split('/').includes('..')) {
    throw new McpBundleError('manifest-invalid', 'manifest field "server.entry_point" must stay inside the bundle')
  }

  const missing = requiredUserConfig(manifest, server)
  if (missing.length > 0) {
    throw new McpBundleError(
      'user-config-required',
      `this bundle asks to be configured on install (${missing.join(', ')}), which this version does not support yet`,
    )
  }

  const compatibility = manifest['compatibility'] === undefined
    ? {}
    : objectField(manifest['compatibility'], 'compatibility')
  const platforms = compatibility['platforms'] === undefined ? [] : compatibility['platforms']
  if (!Array.isArray(platforms) || platforms.some(entry => typeof entry !== 'string')) {
    throw new McpBundleError('manifest-invalid', 'manifest field "compatibility.platforms" must be an array of strings')
  }
  const runtimes = compatibility['runtimes'] === undefined
    ? {}
    : objectField(compatibility['runtimes'], 'compatibility.runtimes')

  const { command, args, env } = resolveMcpConfig(server, variables, platform)
  const homepage = optionalString(manifest['homepage'])
  const nodeRange = optionalString(runtimes['node'])
  const appRange = optionalString(compatibility['dsh'])
  return {
    id,
    displayName: optionalString(manifest['display_name']) ?? id,
    version,
    description,
    author: authorName(manifest['author']),
    ...(homepage === undefined ? {} : { homepage }),
    serverType: type,
    entryPoint,
    ...(command === undefined ? {} : { command }),
    args,
    env,
    platforms,
    ...(nodeRange === undefined ? {} : { nodeRange }),
    ...(appRange === undefined ? {} : { appRange }),
  }
}

/**
 * Check the compatibility facts this host enforces.
 *
 * Only `platforms` is enforced: it is a fact about the bundle rather than a
 * version range, and a bundle that declares the wrong platform cannot run at
 * all. Declared version ranges are surfaced in the interface instead, because
 * this installer does not evaluate them.
 * @param manifest - the resolved manifest.
 * @param platform - the running platform.
 */
export function checkPlatformCompatibility(manifest: ResolvedBundleManifest, platform: string): void {
  if (manifest.platforms.length > 0 && !manifest.platforms.includes(platform)) {
    throw new McpBundleError(
      'incompatible',
      `this bundle supports ${manifest.platforms.join(', ')}, not ${platform}`,
    )
  }
}

/** How one bundle's server process is launched. */
export interface BundleServerPlan {
  /** Executable to spawn. */
  readonly command: string
  /** Arguments passed to it, without shell interpretation. */
  readonly args: readonly string[]
  /** Environment merged over the scrubbed ambient environment. */
  readonly env: Readonly<Record<string, string>>
  /** Working directory for the server process. */
  readonly cwd: string
}

/** What planning a launch needs beyond the manifest. */
export interface BundleServerContext {
  /** The absolute directory the installed version occupies. */
  readonly directory: string
  /** The binary to use for `node` servers. */
  readonly runtime: string
}

/**
 * Resolve a path the manifest states against the installed directory, refusing
 * anything that leaves it or is not there.
 * @param manifest - the manifest, for the refusal message.
 * @param context - the installed directory.
 * @param declared - the path the manifest declared, already substituted.
 * @param requireExecutable - whether the result must be runnable.
 * @returns the absolute path.
 */
function insideBundle(
  manifest: ResolvedBundleManifest,
  context: BundleServerContext,
  declared: string,
  requireExecutable = false,
): string {
  const base = resolve(context.directory)
  const path = isAbsolute(declared) ? resolve(declared) : resolve(base, declared)
  if (path !== base && !path.startsWith(base + sep)) {
    throw new McpBundleError('bundle-invalid', `${JSON.stringify(declared)} points outside the bundle's own directory`)
  }
  if (!existsSync(path)) {
    const missing = manifest.serverType === 'node' ? 'its entry point' : 'its executable'
    throw new McpBundleError('bundle-invalid', `the bundle is missing ${missing}: ${declared}`)
  }
  if (requireExecutable) {
    try {
      accessSync(path, constants.X_OK)
    } catch (error: unknown) {
      throw new McpBundleError('bundle-invalid', `the bundle's executable is not runnable: ${declared}`, { cause: error })
    }
  }
  return path
}

/**
 * Plan the server process for one installed bundle.
 *
 * A bundle never names the runtime itself: the specification treats
 * `mcp_config.command` as a statement of intent (`"node"`), and the host is
 * expected to supply a runtime it already carries — which is what lets a user
 * install a Node server on a machine that has no Node installed. Here that
 * runtime is this application's own binary, re-entered as Node.
 * @param manifest - the validated manifest of the installed version.
 * @param context - the installation's runtime and directory.
 * @returns the launch plan the generated patch carries.
 */
export function planBundleServer(manifest: ResolvedBundleManifest, context: BundleServerContext): BundleServerPlan {
  if (manifest.serverType === 'node') {
    // The declared entry point is checked even when `mcp_config` names its own
    // argv: a bundle that carries no server would otherwise install and fail
    // on every launch instead of being refused once.
    const entry = insideBundle(manifest, context, manifest.entryPoint)
    return {
      command: context.runtime,
      args: manifest.args.length > 0 ? [...manifest.args] : [entry],
      env: { ELECTRON_RUN_AS_NODE: '1', ...manifest.env },
      cwd: context.directory,
    }
  }
  return {
    command: insideBundle(manifest, context, manifest.command ?? manifest.entryPoint, true),
    args: [...manifest.args],
    env: { ...manifest.env },
    cwd: context.directory,
  }
}

/** Where an installed bundle came from, kept for display. */
export interface McpBundleSource {
  /** A file the user picked, or a URL it was downloaded from. */
  readonly kind: 'file' | 'url'
  /** The absolute path or the URL. */
  readonly value: string
}

/** One installed bundle as the panel lists it. */
export interface McpBundleRecord {
  /** Install identity, derived from the manifest name. */
  readonly id: string
  /** The generated plugin's package name, as the profile manifest records it. */
  readonly name: string
  /** The profile-relative dependency spec the generated plugin is recorded as. */
  readonly spec: string
  /** Human name shown in the interface. */
  readonly displayName: string
  /** The installed version. */
  readonly version: string
  /** The namespace its tools are registered under. */
  readonly serverName: string
  /** Whether the profile mounts it. */
  readonly enabled: boolean
  /** One-line description from the manifest. */
  readonly description: string
  /** Author name from the manifest. */
  readonly author: string
  /** Homepage from the manifest, when it declared one. */
  readonly homepage?: string
  /** Where it was installed from. */
  readonly source: McpBundleSource
  /** When it was installed, as an ISO timestamp. */
  readonly installedAt: string
  /** Platforms the manifest declared; empty means all. */
  readonly platforms: readonly string[]
  /** The Node range the manifest declared, shown rather than enforced. */
  readonly nodeRange?: string
  /** The application range the manifest declared, shown rather than enforced. */
  readonly appRange?: string
  /** Why a bundle is not usable, when a recorded failure explains it. */
  readonly detail?: string
  /** Model-facing tool names; the field exists for surfaces that report them, and an install stores none. */
  readonly tools: readonly string[]
}

/** The registry file's contents. */
interface McpBundleRegistry {
  /** Format marker, so a future version can refuse an older layout loudly. */
  readonly version: number
  /** Every installed bundle, in install order. */
  readonly bundles: readonly McpBundleRecord[]
}

/** Store configuration: the directories and runtime one install writes into. */
export interface McpBundleStoreOptions {
  /** The plugin directory holding every bundle's versioned payload (`$DSH_HOME/plugins`). */
  readonly pluginsDir: string
  /** The desktop profile the generated plugin directories are written into. */
  readonly profileDir: string
  /** The executable the generated patch re-enters as Node for `node` servers. */
  readonly nodeRuntime: string
  /** Host packages every generated plugin declares as peers, with the spec each is pinned to. */
  readonly peerPackages: Readonly<Record<string, string>>
  /** Platform the manifest must declare; defaults to the running one. */
  readonly platform?: string
  /** Home directory `${HOME}` resolves against; defaults to the invoking user's. */
  readonly home?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one parsed registry entry carries every field a record needs. */
function isBundleRecord(value: unknown): value is McpBundleRecord {
  if (!isRecord(value)) return false
  const strings = ['id', 'name', 'spec', 'displayName', 'version', 'serverName', 'description', 'author', 'installedAt']
  if (strings.some(field => typeof value[field] !== 'string')) return false
  if (typeof value['enabled'] !== 'boolean') return false
  if (!Array.isArray(value['platforms']) || value['platforms'].some(entry => typeof entry !== 'string')) return false
  if (!Array.isArray(value['tools']) || value['tools'].some(entry => typeof entry !== 'string')) return false
  const source = value['source']
  if (!isRecord(source) || (source['kind'] !== 'file' && source['kind'] !== 'url') || typeof source['value'] !== 'string') return false
  return ['homepage', 'nodeRange', 'appRange', 'detail'].every(field => value[field] === undefined || typeof value[field] === 'string')
}

/**
 * Read `installed.json`, treating absence as the empty registry.
 * @param directory - the plugin directory.
 * @returns the parsed registry.
 */
function readRegistry(directory: string): McpBundleRegistry {
  const path = join(directory, REGISTRY_FILENAME)
  if (!existsSync(path)) return { version: REGISTRY_FORMAT, bundles: [] }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error: unknown) {
    throw new McpBundleError('io-failed', `${path} is not readable JSON`, { cause: error })
  }
  if (!isRecord(value) || value['version'] !== REGISTRY_FORMAT || !Array.isArray(value['bundles'])) {
    throw new McpBundleError('io-failed', `${path} was not written by this application's bundle format`)
  }
  const bundles: McpBundleRecord[] = []
  for (const entry of value['bundles'] as readonly unknown[]) {
    if (!isBundleRecord(entry)) {
      throw new McpBundleError('io-failed', `${path} was not written by this application's bundle format`)
    }
    bundles.push(entry)
  }
  return { version: REGISTRY_FORMAT, bundles }
}

/**
 * Write the registry atomically: a temporary sibling replaces the record, so a
 * write that failed halfway never decides what the next launch mounts.
 * @param directory - the plugin directory.
 * @param registry - the next contents.
 * @returns after the replacement is in place.
 */
async function writeRegistry(directory: string, registry: McpBundleRegistry): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, REGISTRY_FILENAME)
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, undefined, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Remove every version of one bundle except the one being kept.
 * @param directory - the plugin directory.
 * @param id - the bundle's install identity.
 * @param keep - the directory to preserve, or `undefined` to remove all.
 */
function pruneVersions(directory: string, id: string, keep: string | undefined): void {
  const versions = join(directory, id)
  if (!existsSync(versions)) return
  if (keep === undefined) {
    rmSync(versions, { recursive: true, force: true })
    return
  }
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    const path = join(versions, entry.name)
    if (path !== keep) rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Write an opened bundle's files under `target`, replacing whatever is there.
 * @param archive - the opened bundle.
 * @param target - the directory to write into; created, and removed on failure.
 */
function extractBundle(archive: BundleArchive, target: string): void {
  rmSync(target, { recursive: true, force: true })
  try {
    for (const [name, content] of archive.entries) {
      const path = join(target, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  } catch (error: unknown) {
    rmSync(target, { recursive: true, force: true })
    throw new McpBundleError('io-failed', `the bundle could not be written to ${target}`, { cause: error })
  }
}

/** One generated plugin: the identity, the host peers, and the launch plan its patch carries. */
interface GeneratedPlugin {
  /** The plugin's package name. */
  readonly name: string
  /** The bundle version the plugin stands for. */
  readonly version: string
  /** The `serverName` namespace the mounted `mcp-client` instance claims. */
  readonly serverName: string
  /** The patch entry id, unique inside the composed entry list. */
  readonly entryId: string
  /** Host packages the plugin declares as peers, with the spec each is pinned to. */
  readonly peerPackages: Readonly<Record<string, string>>
  /** The server launch plan the patch states. */
  readonly plan: BundleServerPlan
}

/** One YAML scalar YAML and JSON both read back unchanged. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Render the patch that mounts this bundle's `mcp-client` instance.
 *
 * The patch is written, never hand-edited: every string is quoted, so a path or
 * environment value a manifest supplied cannot change the document's shape.
 * @param plugin - the generated plugin.
 * @returns the patch file's contents.
 */
function patchText(plugin: GeneratedPlugin): string {
  const lines = [
    '# Generated by the Desktop shell for one installed MCP bundle.',
    '# Reinstalling or enabling that bundle rewrites this file; do not edit it.',
    '- insert:',
    `    - id: ${yamlString(plugin.entryId)}`,
    `      name: ${yamlString(MCP_CLIENT_PACKAGE)}`,
    '      config:',
    '        transport: "stdio"',
    `        serverName: ${yamlString(plugin.serverName)}`,
    `        command: ${yamlString(plugin.plan.command)}`,
  ]
  const args = plugin.plan.args
  if (args.length === 0) lines.push('        args: []')
  else lines.push('        args:', ...args.map(arg => `          - ${yamlString(arg)}`))
  const env = Object.entries(plugin.plan.env)
  if (env.length === 0) lines.push('        env: {}')
  else lines.push('        env:', ...env.map(([key, value]) => `          ${yamlString(key)}: ${yamlString(value)}`))
  lines.push(
    `        cwd: ${yamlString(plugin.plan.cwd)}`,
    '        toolCallTimeoutMs: 60000',
    '        failOnStartupError: true',
    '',
  )
  return lines.join('\n')
}

/**
 * Write the generated plugin: the package the profile manager validates, and
 * the patch that mounts the bundle's server.
 * @param directory - the plugin's directory inside the profile.
 * @param plugin - what the plugin must state.
 */
function writeGeneratedPlugin(directory: string, plugin: GeneratedPlugin): void {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const manifest = {
    name: plugin.name,
    version: plugin.version,
    private: true,
    type: 'module',
    dsh: { bundle: { patch: `./${PLUGIN_PATCH_FILENAME}` } },
    peerDependencies: plugin.peerPackages,
  }
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, PLUGIN_PATCH_FILENAME), patchText(plugin), { mode: 0o600 })
}

/**
 * The installed-bundle store: which bundles exist, and the payload and
 * generated plugin each one owns.
 *
 * One instance owns one plugin directory. Every mutation goes through it so the
 * registry file, the payload, and the generated plugin cannot disagree.
 */
export class McpBundleStore {
  private readonly pluginsDir: string
  private readonly profileDir: string
  private readonly nodeRuntime: string
  private readonly peerPackages: Readonly<Record<string, string>>
  private readonly platform: string
  private readonly home: string

  /** @param options - the directories, runtime, and host peers an install writes with. */
  constructor(options: McpBundleStoreOptions) {
    this.pluginsDir = options.pluginsDir
    this.profileDir = options.profileDir
    this.nodeRuntime = options.nodeRuntime
    this.peerPackages = options.peerPackages
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? homedir()
  }

  /** The directory every installed bundle's payload lives under. */
  get root(): string {
    return this.pluginsDir
  }

  /** @returns the directory of one bundle's generated plugin inside the profile. */
  pluginDirectory(id: string): string {
    return join(this.profileDir, 'plugins', id)
  }

  /** List every installed bundle, in install order. */
  list(): readonly McpBundleRecord[] {
    return readRegistry(this.pluginsDir).bundles
  }

  /**
   * Install from a file on disk.
   * @param path - the bundle's absolute path.
   * @returns the installed bundle.
   */
  async installFromFile(path: string): Promise<McpBundleRecord> {
    if (!existsSync(path)) throw new McpBundleError('not-found', `no file at ${path}`)
    let bytes: Uint8Array
    try {
      bytes = await readFile(path)
    } catch (error: unknown) {
      throw new McpBundleError('io-failed', `the bundle at ${path} could not be read`, { cause: error })
    }
    return this.install(bytes, { kind: 'file', value: path })
  }

  /**
   * Install from an http(s) URL.
   * @param url - the bundle's URL.
   * @returns the installed bundle.
   */
  async installFromUrl(url: string): Promise<McpBundleRecord> {
    return this.install(await downloadBundle(url), { kind: 'url', value: url })
  }

  /**
   * Stop mounting a bundle without removing it.
   * @param id - the bundle's install identity.
   * @param enabled - the state to move it to.
   * @returns the bundle afterwards.
   */
  async setEnabled(id: string, enabled: boolean): Promise<McpBundleRecord> {
    const registry = readRegistry(this.pluginsDir)
    const record = registry.bundles.find(entry => entry.id === id)
    if (record === undefined) throw new McpBundleError('not-found', `no bundle installed as ${JSON.stringify(id)}`)
    const updated: McpBundleRecord = { ...record, enabled }
    await writeRegistry(this.pluginsDir, {
      version: registry.version,
      bundles: registry.bundles.map(entry => (entry.id === id ? updated : entry)),
    })
    return updated
  }

  /**
   * Remove a bundle: its payload, its generated plugin, and its record.
   * @param id - the bundle's install identity.
   * @returns after the directory and the record are both gone.
   */
  async remove(id: string): Promise<void> {
    const registry = readRegistry(this.pluginsDir)
    if (!registry.bundles.some(entry => entry.id === id)) {
      throw new McpBundleError('not-found', `no bundle installed as ${JSON.stringify(id)}`)
    }
    pruneVersions(this.pluginsDir, id, undefined)
    rmSync(this.pluginDirectory(id), { recursive: true, force: true })
    await writeRegistry(this.pluginsDir, {
      version: registry.version,
      bundles: registry.bundles.filter(entry => entry.id !== id),
    })
  }

  /**
   * Install already-read bytes.
   * @param bytes - the bundle archive.
   * @param source - where it came from, recorded for display.
   * @returns the installed bundle.
   */
  private async install(bytes: Uint8Array, source: McpBundleSource): Promise<McpBundleRecord> {
    const archive = openBundle(bytes)
    const raw = JSON.parse(archive.manifest) as unknown
    const probe = parseBundleManifest(raw, { dirname: this.pluginsDir, home: this.home }, this.platform)
    checkPlatformCompatibility(probe, this.platform)

    const target = join(this.pluginsDir, probe.id, probe.version)
    const staging = join(this.pluginsDir, probe.id, `tmp-${String(process.pid)}-${String(Date.now())}`)
    extractBundle(archive, staging)
    // Planning against the staged tree, before anything is committed, is what
    // makes an unrunnable bundle a refusal rather than a plugin that appears and
    // then fails on every launch.
    try {
      const staged = parseBundleManifest(raw, { dirname: staging, home: this.home }, this.platform)
      planBundleServer(staged, { directory: staging, runtime: this.nodeRuntime })
    } catch (error: unknown) {
      rmSync(staging, { recursive: true, force: true })
      try {
        // Only a directory this refusal created is removed: a bundle already
        // installed under the same id keeps its version, so a failed upgrade
        // cannot take a working install with it.
        rmdirSync(join(this.pluginsDir, probe.id))
      } catch {
        // The bundle has an installed version, so the directory stays.
      }
      throw error
    }

    mkdirSync(join(this.pluginsDir, probe.id), { recursive: true, mode: 0o700 })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    pruneVersions(this.pluginsDir, probe.id, target)

    // The committed tree plans identically to the staged one; its paths are what
    // the generated patch must state, so the plan is resolved against it.
    const manifest = parseBundleManifest(raw, { dirname: target, home: this.home }, this.platform)
    const plan = planBundleServer(manifest, { directory: target, runtime: this.nodeRuntime })

    const serverName = toServerName(probe.id)
    const pluginName = bundlePluginPackageName(probe.id)
    writeGeneratedPlugin(this.pluginDirectory(probe.id), {
      name: pluginName,
      version: probe.version,
      serverName,
      entryId: `mcp-bundle-${serverName}`,
      peerPackages: { [MCP_CLIENT_PACKAGE]: this.peerPackages[MCP_CLIENT_PACKAGE] ?? '*', ...this.peerPackages },
      plan,
    })

    const registry = readRegistry(this.pluginsDir)
    const previous = registry.bundles.find(entry => entry.id === probe.id)
    const homepage = probe.homepage
    const nodeRange = probe.nodeRange
    const appRange = probe.appRange
    const detail = previous?.detail
    const record: McpBundleRecord = {
      id: probe.id,
      name: pluginName,
      spec: bundlePluginSpec(probe.id),
      displayName: probe.displayName,
      version: probe.version,
      serverName: previous?.serverName ?? serverName,
      enabled: previous?.enabled ?? true,
      description: probe.description,
      author: probe.author,
      ...(homepage === undefined ? {} : { homepage }),
      source,
      installedAt: new Date().toISOString(),
      platforms: probe.platforms,
      ...(nodeRange === undefined ? {} : { nodeRange }),
      ...(appRange === undefined ? {} : { appRange }),
      tools: [],
      ...(detail === undefined ? {} : { detail }),
    }
    await writeRegistry(this.pluginsDir, {
      version: registry.version,
      bundles: [...registry.bundles.filter(entry => entry.id !== probe.id), record],
    })
    return record
  }
}
