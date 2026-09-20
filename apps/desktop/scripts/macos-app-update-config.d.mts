/** Resolved GitHub release a packaged macOS application updates from. */
export interface MacOSAppUpdateFeed {
  readonly owner: string
  readonly repo: string
  readonly releaseType: 'release' | 'prerelease'
}

/** Packaged electron-updater configuration for macOS. */
export interface MacOSAppUpdateConfig {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly releaseType: 'release' | 'prerelease'
  readonly updaterCacheDirName: string
}

/** Resolve the GitHub release from the final electron-builder configuration. */
export function resolveMacOSAppUpdateFeed(publish: unknown): MacOSAppUpdateFeed

/** Create the electron-updater configuration embedded before code signing. */
export function createMacOSAppUpdateConfig(
  destination: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): MacOSAppUpdateConfig

/** Write the updater configuration into an assembled App before signing. */
export function writeMacOSAppUpdateConfig(
  resourcesDir: string,
  destination: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): Promise<void>

/** Verify the updater configuration inside an assembled macOS App. */
export function verifyMacOSAppUpdateConfig(
  appPath: string,
  destination: MacOSAppUpdateFeed,
  updaterCacheDirName?: string,
): Promise<void>
