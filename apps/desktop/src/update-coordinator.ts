/** One Electron release stream for the version-bound shell and bundled dsh runtime. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import type { DesktopUpdateState } from './ipc.ts'
const { autoUpdater } = electronUpdater

/** Checks, downloads, and installs one complete Desktop release. */
export class DesktopUpdateCoordinator {
  private availableVersion: string | undefined
  private current: DesktopUpdateState = { phase: 'idle' }
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  /**
   * @param publish - state sink for every desktop window.
   * @param beforeRestart - stop application-owned processes before replacement.
   * @param updater - Electron artifact updater; replaceable for tests.
   * @param enabled - whether this packaged process carries updater configuration.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<void> = async () => {},
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => (
      app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
    ),
  ) {
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  /** Last state published to desktop windows, retained while the user keeps working. */
  get state(): DesktopUpdateState { return this.current }

  /** Check the configured Desktop release stream and retain an available version. */
  async check(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    if (this.checkOperation !== undefined) return this.checkOperation
    this.checkOperation = this.doCheck().finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  /** Wait for an in-flight check, then download and install its retained release. */
  async install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      return this.doInstall()
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  private retain(state: DesktopUpdateState): DesktopUpdateState {
    this.current = state
    return this.publish(state)
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    this.retain({ phase: 'checking' })
    try {
      if (!this.enabled()) {
        this.availableVersion = undefined
        return this.retain({ phase: 'idle' })
      }
      const result = await this.updater.checkForUpdates()
      const version = result?.isUpdateAvailable === true ? result.updateInfo.version : undefined
      this.availableVersion = version
      return version === undefined
        ? this.retain({ phase: 'idle' })
        : this.retain({ phase: 'available', version })
    } catch (error) {
      // A check that cannot reach the feed must not erase a release the user already
      // declined: the retained version keeps Install available after the fact.
      const version = this.availableVersion
      return this.retain({
        phase: 'error',
        ...(version === undefined ? {} : { version }),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async doInstall(): Promise<DesktopUpdateState> {
    const version = this.availableVersion
    if (version === undefined) {
      throw new Error('desktop update: no verified update is available')
    }
    this.retain({ phase: 'installing', version })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      return this.retain({ phase: 'error', version, message: error instanceof Error ? error.message : String(error) })
    }
    // The download is only forgotten once the restart succeeded: a failed handoff
    // leaves the application running with the old release and the update installable.
    const ready = this.retain({ phase: 'ready', version })
    try {
      await this.beforeRestart()
    } catch (error) {
      return this.retain({ phase: 'error', version, message: error instanceof Error ? error.message : String(error) })
    }
    this.availableVersion = undefined
    this.updater.quitAndInstall(false, true)
    return ready
  }
}
