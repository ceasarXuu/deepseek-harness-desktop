/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Environment variable that names the repository serving the test deployment. */
export const DESKTOP_UPDATE_REPOSITORY_ENV: 'DSH_DESKTOP_UPDATE_REPOSITORY'

/** Upload credentials this fork accepts, in the order a local run should provide them. */
export const DESKTOP_UPLOAD_TOKEN_ENV_NAMES: readonly ['GH_TOKEN', 'GITHUB_TOKEN']

/** Supported Desktop update deployment. */
export type DesktopAutoUpdateEnvironment = 'test' | 'production'

/** Directory name of one supported Desktop release target. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** GitHub release serving one Desktop update target. */
export interface DesktopAutoUpdateConfig {
  readonly environment: DesktopAutoUpdateEnvironment
  readonly target: DesktopAutoUpdateTarget
  readonly owner: string
  readonly repo: string
  readonly tag: string
  readonly releaseType: 'release' | 'prerelease'
  readonly metadataFilename: string
  readonly publicUrl: string
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param env - Packaging or upload environment.
 * @returns Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopAutoUpdateEnvironment

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateTarget

/**
 * Return the local completion record filename for one packaged target.
 * @param target - Supported release target.
 * @returns Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @returns Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(
  version: string,
  platform: NodeJS.Platform,
): string

/**
 * Resolve the release tag one version publishes under.
 * @param version - Desktop semantic version.
 * @returns Release tag serving that version.
 */
export function desktopReleaseTag(version: string): string

/**
 * Read the upload credential from the first environment variable that carries one.
 * @param env - Upload environment.
 * @returns Non-empty GitHub token.
 */
export function resolveDesktopUploadToken(env: NodeJS.ProcessEnv): string

/**
 * Resolve the release destination for one target.
 * @param env - Packaging or upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @param version - Desktop semantic version being packaged.
 * @returns Resolved update destination.
 * @throws When the selected deployment lacks a repository, or the version is not semantic.
 */
export function resolveDesktopAutoUpdateConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
  version: string,
): DesktopAutoUpdateConfig
