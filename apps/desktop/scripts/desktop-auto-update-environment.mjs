/** Resolve the Desktop update deployment and the GitHub release that serves it. */

import { prerelease, valid } from 'semver'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Environment variable that names the repository serving the test deployment. */
export const DESKTOP_UPDATE_REPOSITORY_ENV = 'DSH_DESKTOP_UPDATE_REPOSITORY'

/** Repository whose releases serve production updates. */
const PRODUCTION_REPOSITORY = 'ceasarXuu/deepseek-harness-desktop'

const UPDATE_ENVIRONMENTS = {
  test: {
    repositoryEnvName: DESKTOP_UPDATE_REPOSITORY_ENV,
    fixedRepository: undefined,
  },
  production: {
    repositoryEnvName: undefined,
    fixedRepository: PRODUCTION_REPOSITORY,
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** Upload credentials this fork accepts, in the order a local run should provide them. */
export const DESKTOP_UPLOAD_TOKEN_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN']

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test" or "production"`)
  }
  return value
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform) {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  const release = prerelease(version)
  const channel = release === null ? 'latest' : String(release[0])
  return `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Resolve the release tag one version publishes under.
 *
 * The updater's GitHub provider reads release tags as semantic versions and matches a
 * prerelease channel by the version's own prerelease component, so the tag is the version
 * with the conventional `v` prefix and no other decoration.
 * @param {string} version - Desktop semantic version.
 * @returns {string} Release tag serving that version.
 */
export function desktopReleaseTag(version) {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  return `v${version}`
}

/**
 * Read one `owner/repository` pair without accepting whitespace or extra path segments.
 * @param {string} value - Candidate repository.
 * @param {string} label - Environment variable or constant the value came from.
 * @returns {{ owner: string, repo: string }} Validated GitHub repository.
 */
function githubRepository(value, label) {
  const parts = value.split('/')
  if (parts.length !== 2 || !parts.every(part => REPOSITORY_PART.test(part))) {
    throw new Error(`desktop auto-update: ${label} must be a GitHub owner/repository pair`)
  }
  return { owner: parts[0], repo: parts[1] }
}

/**
 * Read the deployment repository without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {{ repositoryEnvName: string | undefined, fixedRepository: string | undefined }} deployment - Selected deployment.
 * @returns {{ owner: string, repo: string }} Repository serving this deployment.
 */
function deploymentRepository(env, deployment) {
  if (deployment.fixedRepository !== undefined) {
    return githubRepository(deployment.fixedRepository, 'the production repository')
  }
  const { repositoryEnvName } = deployment
  if (repositoryEnvName === undefined) throw new Error('desktop auto-update: selected deployment has no repository')
  const value = env[repositoryEnvName]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${repositoryEnvName} must be set to a non-empty value`)
  }
  return githubRepository(value, repositoryEnvName)
}

/**
 * Read the upload credential from the first environment variable that carries one.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @returns {string} Non-empty GitHub token.
 */
export function resolveDesktopUploadToken(env) {
  for (const name of DESKTOP_UPLOAD_TOKEN_ENV_NAMES) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  throw new Error(`desktop upload: ${DESKTOP_UPLOAD_TOKEN_ENV_NAMES.join(' or ')} must be set to a non-empty value`)
}

/**
 * Resolve the release destination for one target.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @param {string} version - Desktop semantic version being packaged.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', owner: string, repo: string, tag: string, releaseType: 'release' | 'prerelease', metadataFilename: string, publicUrl: string }} Resolved update destination.
 * @throws {Error} When the selected deployment lacks a repository, or the version is not semantic.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch, version) {
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const { owner, repo } = deploymentRepository(env, UPDATE_ENVIRONMENTS[environment])
  const tag = desktopReleaseTag(version)
  const metadataFilename = desktopUpdateMetadataFilename(version, platform)
  return {
    environment,
    target,
    owner,
    repo,
    tag,
    releaseType: prerelease(version) === null ? 'release' : 'prerelease',
    metadataFilename,
    publicUrl: `https://github.com/${owner}/${repo}/releases/download/${tag}/`,
  }
}
