/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopBundleRecord, DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  pluginsToggle: 'dsh-desktop:plugins-toggle',
  pluginsDisableAll: 'dsh-desktop:plugins-disable-all',
  bundlesList: 'dsh-desktop:bundles-list',
  bundlesInstallFile: 'dsh-desktop:bundles-install-file',
  bundlesInstallUrl: 'dsh-desktop:bundles-install-url',
  bundlesToggle: 'dsh-desktop:bundles-toggle',
  bundlesRemove: 'dsh-desktop:bundles-remove',
  bundlesPickFile: 'dsh-desktop:bundles-pick-file',
  backendStatus: 'dsh-desktop:backend-status',
  backendRetry: 'dsh-desktop:backend-retry',
  applicationRestart: 'dsh-desktop:application-restart',
  configurationReset: 'dsh-desktop:configuration-reset',
  backendState: 'dsh-desktop:backend-state',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
    toggle(name: string, enabled: boolean): Promise<void>
    disableAll(): Promise<void>
  }
  readonly bundles: {
    list(): Promise<readonly DesktopBundleRecord[]>
    installFromPath(path: string): Promise<void>
    installFromUrl(url: string): Promise<void>
    setEnabled(id: string, enabled: boolean): Promise<void>
    remove(id: string): Promise<void>
    pickFile(): Promise<string | undefined>
  }
  readonly backend: {
    status(): Promise<DesktopBackendState>
    retry(): Promise<void>
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
}

/** Startup-page controls, unavailable to backend-provided application documents. */
export interface DshDesktopStartupApi extends Pick<DshDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: Omit<DshDesktopApi['backend'], 'retry'>
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}
