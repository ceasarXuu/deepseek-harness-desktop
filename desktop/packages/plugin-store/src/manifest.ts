/**
 * The bundle manifest a plugin ships, as the MCP Bundle specification defines
 * it, reduced to the fields this store acts on: identity, the server block it
 * will run, and the compatibility it declared.
 *
 * The manifest is untrusted input read from a file a user picked, so every
 * field is validated here rather than narrowed at each use.
 *
 * @module @deepseek-ai/dsh-desktop-plugin-store/manifest
 */

/** A plugin failure a person can act on; `message` is written for the panel. */
export class PluginError extends Error {
  /** Stable code for callers that branch without parsing text. */
  readonly code: PluginErrorCode

  constructor(code: PluginErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Why an install or a load was refused. */
export type PluginErrorCode =
  | 'bundle-invalid'
  | 'manifest-invalid'
  | 'server-unsupported'
  | 'incompatible'
  | 'user-config-required'
  | 'not-found'
  | 'already-installed'
  | 'io-failed'

/** The server kinds this store can launch. */
export type SupportedServerType = 'node' | 'binary'

/** The `mcp_config` block, including the per-platform override the spec defines. */
export interface McpConfig {
  command?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  platform_overrides?: Readonly<Record<string, { command?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }>>
}

/** The `server` block, before validation. */
interface RawServer {
  type?: unknown
  entry_point?: unknown
  mcp_config?: unknown
}

/** What a validated manifest states, with every field the store needs resolved. */
export interface ResolvedManifest {
  /** Machine-readable name from the manifest, used as the install identity. */
  id: string
  /** Human name for the interface. */
  displayName: string
  /** The manifest's declared version. */
  version: string
  /** One-line description. */
  description: string
  /** Author name, when the manifest names one. */
  author: string
  /** Homepage, when the manifest names one. */
  homepage?: string
  /** Icon path inside the bundle, when the manifest names one. */
  icon?: string
  /** Which runtime the server needs. */
  serverType: SupportedServerType
  /** Server entry point, relative to the bundle root. */
  entryPoint: string
  /** The `mcp_config.command` the manifest declared, substituted; a binary server uses it as its relative executable path. */
  command?: string
  /** Extra argv elements from `mcp_config`, already substituted. */
  args: readonly string[]
  /** Extra environment from `mcp_config`, already substituted. */
  env: Readonly<Record<string, string>>
  /** Platforms the manifest declares, already checked against this one. */
  platforms: readonly string[]
  /** The declared Node runtime range, shown rather than enforced. */
  nodeRange?: string
  /** The declared range for this application, shown rather than enforced. */
  appRange?: string
}

/** The values `${...}` placeholders resolve against. */
export interface SubstitutionVariables {
  /** Absolute path of the installed plugin's own directory. */
  dirname: string
  /** The invoking user's home directory. */
  home: string
}

/** Directory names under `$HOME` the specification lets a manifest reference. */
const HOME_SUBDIRECTORIES: Readonly<Record<string, string>> = {
  DESKTOP: 'Desktop',
  DOCUMENTS: 'Documents',
  DOWNLOADS: 'Downloads',
}

/** Characters a plugin id may contain after normalization. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The shape `serverName` must take for `mcp-client` to accept it. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Normalize a manifest name into the install identity.
 * @param name - the manifest's machine-readable name.
 * @returns a lowercase, dash-separated id.
 */
export function toPluginId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!ID_PATTERN.test(id)) {
    throw new PluginError('manifest-invalid', `manifest name "${name}" does not yield a usable plugin id`)
  }
  return id
}

/**
 * Derive the MCP server namespace for a plugin.
 *
 * `mcp-client` requires `[A-Za-z0-9_-]{1,32}` and refuses duplicates at load,
 * so the id is truncated with a short digest of the whole id appended: two ids
 * that share a prefix still get distinct namespaces.
 * @param id - the plugin's install identity.
 * @returns a stable server namespace.
 */
export function toServerName(id: string): string {
  const slug = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  let digest = 5381
  for (const character of id) digest = ((digest * 33) ^ character.codePointAt(0)!) >>> 0
  const name = `${slug === '' ? 'plugin' : slug}-${digest.toString(16).slice(0, 6)}`
  /* c8 ignore next -- the digest makes the length invariant hold for every id */
  if (!SERVER_NAME_PATTERN.test(name)) throw new PluginError('manifest-invalid', `plugin id "${id}" has no usable server name`)
  return name
}

/**
 * Replace the placeholders the MCP Bundle specification defines.
 *
 * `user_config.*` is not substituted: a bundle that needs it is refused at
 * validation, because a value this store cannot collect would silently reach
 * the server as an empty string.
 * @param text - one argument or environment value.
 * @param variables - the installation's resolved paths.
 * @returns the text with every supported placeholder replaced.
 */
export function substituteVariables(text: string, variables: SubstitutionVariables): string {
  return text.replace(/\$\{([^}]*)\}/g, (match, key: string) => {
    if (key === '__dirname') return variables.dirname
    if (key === 'HOME') return variables.home
    if (key === 'pathSeparator' || key === '/') return '/'
    const subdirectory = HOME_SUBDIRECTORIES[key]
    if (subdirectory !== undefined) return `${variables.home}/${subdirectory}`
    return match
  })
}

/**
 * Every `user_config` key a manifest's `mcp_config` references.
 * @param server - the manifest's raw `server` block.
 * @returns the referenced keys, deduplicated, in first-seen order.
 */
export function referencedUserConfig(server: RawServer): string[] {
  const keys = new Set<string>()
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const found of value.matchAll(/\$\{user_config\.([^}]+)\}/g)) keys.add(found[1]!)
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

/** Read the manifest's object field, or raise the manifest as invalid. */
function objectField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError('manifest-invalid', `manifest field "${field}" must be an object`)
  }
  return value as Record<string, unknown>
}

/** Read the manifest's non-empty string field, or raise the manifest as invalid. */
function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PluginError('manifest-invalid', `manifest field "${field}" must be a non-empty string`)
  }
  return value
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

/** The optional string field, or `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
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
  const override = overrides[platform] === undefined ? {} : objectField(overrides[platform], 'server.mcp_config.platform_overrides')
  const merged = { ...raw, ...override }

  const command = merged['command'] === undefined
    ? undefined
    : substituteVariables(stringField(merged['command'], 'server.mcp_config.command'), variables)

  const args = merged['args'] === undefined ? [] : merged['args']
  if (!Array.isArray(args) || args.some(entry => typeof entry !== 'string')) {
    throw new PluginError('manifest-invalid', 'manifest field "server.mcp_config.args" must be an array of strings')
  }
  const env: Record<string, string> = {}
  if (merged['env'] !== undefined) {
    for (const [key, value] of Object.entries(objectField(merged['env'], 'server.mcp_config.env'))) {
      if (typeof value !== 'string') {
        throw new PluginError('manifest-invalid', `manifest field "server.mcp_config.env.${key}" must be a string`)
      }
      env[key] = substituteVariables(value, variables)
    }
  }
  return { command, args: args.map(entry => substituteVariables(entry, variables)), env }
}

/**
 * Validate a parsed `manifest.json` into the shape the store acts on.
 *
 * Validation is structural plus the two facts that decide whether anything can
 * run at all: the server kind is one this host can launch, and the bundle does
 * not depend on configuration this host cannot yet collect.
 * @param raw - the parsed manifest.
 * @param variables - the installation's resolved paths.
 * @param platform - the platform whose `platform_overrides` apply.
 * @returns the resolved manifest.
 */
export function parseManifest(raw: unknown, variables: SubstitutionVariables, platform: string): ResolvedManifest {
  const manifest = objectField(raw, 'manifest.json')
  stringField(manifest['manifest_version'], 'manifest_version')
  const id = toPluginId(stringField(manifest['name'], 'name'))
  const version = stringField(manifest['version'], 'version')
  if (typeof manifest['description'] !== 'string' || manifest['description'].trim() === '') {
    throw new PluginError('manifest-invalid', 'manifest field "description" must be a non-empty string')
  }
  if (manifest['author'] === undefined) {
    throw new PluginError('manifest-invalid', 'manifest field "author" is required')
  }

  const server = objectField(manifest['server'], 'server')
  const type = stringField(server['type'], 'server.type')
  if (type !== 'node' && type !== 'binary') {
    throw new PluginError(
      'server-unsupported',
      `this application runs "node" and "binary" plugins; this bundle declares "${type}"`,
    )
  }
  const entryPoint = stringField(server['entry_point'], 'server.entry_point')
  if (entryPoint.startsWith('/') || entryPoint.split('/').includes('..')) {
    throw new PluginError('manifest-invalid', 'manifest field "server.entry_point" must stay inside the bundle')
  }

  const missing = referencedUserConfig(server)
  if (missing.length > 0) {
    throw new PluginError(
      'user-config-required',
      `this plugin asks to be configured on install (${missing.join(', ')}), which this version does not support yet`,
    )
  }

  const compatibility = manifest['compatibility'] === undefined
    ? {}
    : objectField(manifest['compatibility'], 'compatibility')
  const platforms = compatibility['platforms'] === undefined ? [] : compatibility['platforms']
  if (!Array.isArray(platforms) || platforms.some(entry => typeof entry !== 'string')) {
    throw new PluginError('manifest-invalid', 'manifest field "compatibility.platforms" must be an array of strings')
  }
  const runtimes = compatibility['runtimes'] === undefined
    ? {}
    : objectField(compatibility['runtimes'], 'compatibility.runtimes')

  const { command, args, env } = resolveMcpConfig(server, variables, platform)
  return {
    id,
    displayName: optionalString(manifest['display_name']) ?? id,
    version,
    description: manifest['description'],
    author: authorName(manifest['author']),
    ...(optionalString(manifest['homepage']) === undefined ? {} : { homepage: optionalString(manifest['homepage'])! }),
    ...(optionalString(manifest['icon']) === undefined ? {} : { icon: optionalString(manifest['icon'])! }),
    serverType: type,
    entryPoint,
    ...(command === undefined ? {} : { command }),
    args,
    env,
    platforms,
    ...(optionalString(runtimes['node']) === undefined ? {} : { nodeRange: optionalString(runtimes['node'])! }),
    ...(optionalString(compatibility['dsh']) === undefined ? {} : { appRange: optionalString(compatibility['dsh'])! }),
  }
}

/**
 * Check the compatibility facts this host enforces.
 *
 * Only `platforms` is enforced: it is a fact about the bundle rather than a
 * version range, and a bundle that declares the wrong platform cannot run at
 * all. Declared version ranges are surfaced in the interface instead, because
 * this store does not evaluate them.
 * @param manifest - the resolved manifest.
 * @param platform - the running platform.
 */
export function checkPlatformCompatibility(manifest: ResolvedManifest, platform: string): void {
  if (manifest.platforms.length > 0 && !manifest.platforms.includes(platform)) {
    throw new PluginError(
      'incompatible',
      `this plugin supports ${manifest.platforms.join(', ')}, not ${platform}`,
    )
  }
}
