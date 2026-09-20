/** Write and verify the updater configuration sealed into a macOS application. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

const CONFIG_FILENAME = 'app-update.yml'

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop macOS update config: ${label} must be an object`)
  }
  return value
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop macOS update config: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the GitHub release a packaged application updates from.
 *
 * The updater's GitHub provider reads the repository and the release type from this file and
 * derives the prerelease channel from the packaged version, so no feed URL is stored.
 * @param {unknown} publish - Final electron-builder publish setting.
 * @returns {{ owner: string, repo: string, releaseType: 'release' | 'prerelease' }} Resolved destination.
 */
export function resolveMacOSAppUpdateFeed(publish) {
  if (!Array.isArray(publish) || publish.length !== 1) {
    throw new Error('desktop macOS update config: publish must contain exactly one provider')
  }
  const provider = object(publish[0], 'publish provider')
  const releaseType = provider.releaseType
  if (provider.provider !== 'github' || (releaseType !== 'release' && releaseType !== 'prerelease')) {
    throw new Error('desktop macOS update config: publish provider must be a GitHub release or prerelease')
  }
  return {
    owner: nonEmptyString(provider.owner, 'publish provider owner'),
    repo: nonEmptyString(provider.repo, 'publish provider repository'),
    releaseType,
  }
}

/**
 * Create the electron-updater configuration embedded before code signing.
 * @param {{ owner: string, repo: string, releaseType: 'release' | 'prerelease' }} destination - Resolved release destination.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {{ provider: 'github', owner: string, repo: string, releaseType: 'release' | 'prerelease', updaterCacheDirName: string }} Packaged updater fields.
 */
export function createMacOSAppUpdateConfig(destination, updaterCacheDirName) {
  return {
    provider: 'github',
    owner: nonEmptyString(destination.owner, 'repository owner'),
    repo: nonEmptyString(destination.repo, 'repository name'),
    releaseType: destination.releaseType,
    updaterCacheDirName: nonEmptyString(updaterCacheDirName, 'updater cache directory'),
  }
}

/**
 * Write the updater configuration into an assembled App before signing.
 * @param {string} resourcesDir - App Contents/Resources directory.
 * @param {{ owner: string, repo: string, releaseType: 'release' | 'prerelease' }} destination - Resolved release destination.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {Promise<void>} Resolves after the configuration is durable.
 */
export async function writeMacOSAppUpdateConfig(resourcesDir, destination, updaterCacheDirName) {
  const config = createMacOSAppUpdateConfig(destination, updaterCacheDirName)
  await writeFile(join(resourcesDir, CONFIG_FILENAME), dump(config, { lineWidth: -1, noRefs: true }))
}

/**
 * Verify the updater configuration inside an assembled macOS App.
 * @param {string} appPath - Application bundle path.
 * @param {{ owner: string, repo: string, releaseType: 'release' | 'prerelease' }} destination - Expected release destination.
 * @param {string | undefined} updaterCacheDirName - Exact cache directory when known.
 * @returns {Promise<void>} Resolves when the packaged configuration matches the release destination.
 */
export async function verifyMacOSAppUpdateConfig(appPath, destination, updaterCacheDirName = undefined) {
  const path = join(appPath, 'Contents', 'Resources', CONFIG_FILENAME)
  let parsed
  try {
    parsed = load(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop macOS update config: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = object(parsed, CONFIG_FILENAME)
  const expected = `${destination.owner}/${destination.repo} ${destination.releaseType}`
  if (config.provider !== 'github'
    || config.owner !== destination.owner
    || config.repo !== destination.repo
    || config.releaseType !== destination.releaseType) {
    throw new Error(`desktop macOS update config: ${path} does not name ${expected}`)
  }
  const actualCacheDirName = nonEmptyString(config.updaterCacheDirName, `${CONFIG_FILENAME}.updaterCacheDirName`)
  if (updaterCacheDirName !== undefined && actualCacheDirName !== updaterCacheDirName) {
    throw new Error(`desktop macOS update config: ${path} has updater cache directory ${actualCacheDirName}; expected ${updaterCacheDirName}`)
  }
}
