/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager, type DesktopProjectHooks } from './project-manager.ts'
import { DesktopHostProcess } from './host-process.ts'
import { DesktopBackendController, type DesktopBackendState } from './backend-controller.ts'
import { DESKTOP_IPC, type DesktopUpdateState } from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { desktopErrorState } from './startup-error.ts'
import { startupFailureDocument } from './startup-document.ts'
import { assembleDesktopDiagnostics } from './diagnostics.ts'
import {
  readFirstLaunchGuideAcknowledged,
  shouldShowFirstLaunchGuide,
  writeFirstLaunchGuideAcknowledged,
} from './first-launch.ts'
import { DESKTOP_RUNTIME_ARCHIVE, ensureDesktopRuntime, type DesktopRuntimeProgress } from './runtime-closure.ts'

const SCHEME = 'dsh-app'
/** Extensions the bundle chooser offers: the MCP Bundle format and its predecessors. */
const BUNDLE_FILE_EXTENSIONS = ['mcpb', 'dxt', 'zip'] as const
let focusPrimaryWindow = (): void => {}
type RecoveryAction = 'restart' | 'plugins' | 'reset'
let profileRecoveryAvailable = (): boolean => false
const emergencyPages = new WeakMap<BrowserWindow, { url: string; message: string; busy: boolean }>()
let recoverApplication = (action: RecoveryAction): Promise<void> => {
  if (action !== 'restart') return Promise.reject(new Error('Desktop recovery could not initialize; reinstall the application'))
  app.relaunch()
  app.quit()
  return Promise.resolve()
}

async function showEmergencyDocument(window: BrowserWindow, message: string): Promise<void> {
  const document = startupFailureDocument(resolveDesktopLocale(app.getLocale()), message, profileRecoveryAvailable())
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
  emergencyPages.set(window, { url, message, busy: false })
  await window.loadURL(url)
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

interface RuntimeResources {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(dsh: string): RuntimeResources {
  const development = !app.isPackaged
  const node = (development ? process.env.DSH_DESKTOP_NODE_BINARY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  return { node, pnpm, dsh }
}

/**
 * Expand the shipped runtime archive when the version in place is not the tree it describes.
 * @param closure - Directory holding one subdirectory per shipped runtime version.
 * @param version - Release version naming this expansion.
 * @param onProgress - Receives first-launch work for the loading window.
 * @returns Absolute path of the verified runtime tree.
 */
async function expandRuntimeArchive(
  closure: string, version: string, onProgress: (progress: DesktopRuntimeProgress) => void,
): Promise<string> {
  return await ensureDesktopRuntime({
    archive: join(process.resourcesPath, DESKTOP_RUNTIME_ARCHIVE),
    home: closure,
    version,
    onProgress,
  })
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault()
    const page = emergencyPages.get(window)
    if (page === undefined || page.busy || window.webContents.getURL() !== page.url) return
    const action = new URL(url)
    if (action.protocol !== 'dsh-recovery:' || !['restart', 'plugins', 'reset'].includes(action.hostname)) return
    if (action.hostname !== 'restart' && !profileRecoveryAvailable()) return
    page.busy = true
    void recoverApplication(action.hostname as RecoveryAction).catch(async (error: unknown) => {
      if (!window.isDestroyed()) await showEmergencyDocument(window, `${page.message}\n${desktopErrorState(error).message}`)
    }).catch((error: unknown) => { console.error(error) }).finally(() => { page.busy = false })
  })
  return window
}

function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

async function main(): Promise<void> {
  const paths = resolveDesktopPaths()
  const development = app.isPackaged ? undefined : join(app.getAppPath(), '.desktop-build', 'development', 'project')
  const activeProject = development ?? paths.profile
  // Every consumer resolves the runtime through the expanded tree rather than the bundle: the
  // archive is what the installer carries, and this is where its contents appear.
  const resources = runtimeResources(development === undefined
    ? join(paths.closure, app.getVersion())
    : process.env.DSH_DESKTOP_DSH_DIR ?? development)
  const manager = new DesktopProjectManager(paths, resources)
  profileRecoveryAvailable = () => development === undefined && manager.canRecoverProfile()
  // The guide belongs to the first start of an installed application: a development
  // project, and a launch that found an existing profile, both skip it.
  const profileExisted = development !== undefined || existsSync(paths.profile)
  let firstLaunchGuideOffered = false
  let pageError: Extract<DesktopBackendState, { phase: 'error' }> | undefined
  let quitting = false
  let startup: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let pluginWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const managementPreload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const startupUrl = `${SCHEME}://shell/startup.html`
  const applicationUrl = `${SCHEME}://app/index.html`
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  let emergencyDocument = false

  const showEmergencyError = async (error: unknown): Promise<void> => {
    if (quitting || emergencyDocument) return
    emergencyDocument = true
    const diagnostic = desktopErrorState(error).message
    pageError = { phase: 'error', message: diagnostic }
    if (mainWindow !== undefined) await showEmergencyDocument(mainWindow, diagnostic)
  }

  const offerFirstLaunchGuide = async (): Promise<void> => {
    if (firstLaunchGuideOffered) return
    if (!shouldShowFirstLaunchGuide({
      profileExisted,
      acknowledged: readFirstLaunchGuideAcknowledged(paths.root),
    })) return
    firstLaunchGuideOffered = true
    const result = await dialog.showMessageBox({
      type: 'info',
      title: messages.firstLaunchGuideTitle,
      message: messages.firstLaunchGuideMessage,
      detail: formatDesktopMessage(messages.firstLaunchGuideDetail, {
        runtime: join(paths.closure, app.getVersion()),
      }),
      buttons: [messages.firstLaunchGuideDismiss],
      checkboxLabel: messages.firstLaunchGuideDontShowAgain,
      checkboxChecked: false,
    })
    // The record lives beside the profile, not inside it, so it survives a reset.
    if (result.checkboxChecked) writeFirstLaunchGuideAcknowledged(paths.root)
  }

  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || emergencyDocument || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || window.isDestroyed() || navigation !== next) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const backendState = (): DesktopBackendState => {
    const state = pageError ?? backend.state
    return state.phase === 'error' ? { ...state, profileRecovery: profileRecoveryAvailable() } : state
  }
  const publishBackend = (state: DesktopBackendState): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.backendState, state)
    }
  }
  const backend = new DesktopBackendController((onFailure) => {
    if (development === undefined) manager.assertProfileRuntime(activeProject)
    const hostInspectPort = developmentHostInspectPort(development !== undefined)
    const host = new DesktopHostProcess(resources.node, development ?? resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure)
    return {
      start: () => host.start(),
      stop: () => host.stop(),
      fetch: (request: Request) => host.fetch(request),
    }
  }, (state) => {
    if (state.phase === 'starting' && !emergencyDocument) pageError = undefined
    publishBackend(backendState())
    if (state.phase === 'error') void navigateMain(startupUrl).catch((error: unknown) => { console.error(error) })
  })

  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesState, state)
    }
    return state
  }

  const hooks: DesktopProjectHooks = {
    beforeChange: () => backend.stop(),
    afterChange: () => backend.start(async () => {}),
  }

  recoverApplication = async (action): Promise<void> => {
    await startup?.catch(() => undefined)
    await backend.stop()
    if (action === 'restart') {
      app.relaunch()
      app.quit()
      return
    }
    if (!profileRecoveryAvailable()) throw new Error(messages.startupReinstallAdvice)
    if (action === 'reset') await manager.resetConfiguration(hooks)
    else await manager.mutate({ type: 'plugins-disable-all' }, hooks)
    emergencyDocument = false
    pageError = undefined
    navigation = undefined
    await navigateMain(applicationUrl)
  }

  const showStartupError = async (error: unknown): Promise<void> => {
    if (quitting) return
    pageError = desktopErrorState(error)
    try { await navigateMain(startupUrl) }
    catch (navigationError) {
      await showEmergencyError(new AggregateError([error, navigationError], messages.startupFailed))
    }
    publishBackend(backendState())
  }
  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      pageError = undefined
      await navigateMain(startupUrl)
      await backend.start(async () => {
        if (development === undefined) {
          await manager.applyRelease()
        }
      })
      if (backend.host !== undefined) {
        await navigateMain(applicationUrl)
        void offerFirstLaunchGuide().catch((error: unknown) => { console.error(error) })
      }
    })().catch(async (error: unknown) => {
      await showStartupError(error)
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      // Keep the application running with the old release when the child cannot
      // stop: the quit that skips child teardown is armed only after stop returns.
      await backend.stop()
      shellInstallerOwnsQuit = true
    },
  )

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellAsset(request).then((response) => {
      if (response.status >= 400 && ['/startup.html', '/startup.js', '/startup.css'].includes(url.pathname)) {
        void showEmergencyError(new Error(`Desktop recovery resource could not be loaded: ${url.pathname} (HTTP ${response.status})`))
          .catch((error: unknown) => { console.error(error) })
      }
      return response
    })
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = backend.host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  const transaction = async (event: IpcMainInvokeEvent, operation: () => Promise<void>): Promise<void> => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) {
      throw new Error('dsh desktop: plugin package changes require a packaged application')
    }
    await startup?.catch(() => undefined)
    pageError = undefined
    await navigateMain(startupUrl)
    try {
      await operation()
      await navigateMain(applicationUrl)
    } catch (error) {
      await showStartupError(error)
      throw error
    }
  }
  const mutate = (event: IpcMainInvokeEvent, mutation: Parameters<DesktopProjectManager['mutate']>[0]): Promise<void> =>
    transaction(event, () => manager.mutate(mutation, hooks))
  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.pluginsList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listPlugins()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsAdd, (event, spec: unknown) => {
    if (typeof spec !== 'string') throw new Error('dsh desktop: plugin spec must be a string')
    return mutate(event, { type: 'plugin-add', spec })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsRemove, (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('dsh desktop: plugin name must be a string')
    return mutate(event, { type: 'plugin-remove', name })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsUpdate, (event, name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error('dsh desktop: plugin name and version must be strings')
    }
    return mutate(event, { type: 'plugin-update', name, version })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsToggle, (event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('dsh desktop: invalid plugin activation request')
    return mutate(event, { type: 'plugin-toggle', name, enabled })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsDisableAll, event => mutate(event, { type: 'plugins-disable-all' }))
  ipcMain.handle(DESKTOP_IPC.bundlesList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listBundles()
  })
  ipcMain.handle(DESKTOP_IPC.bundlesInstallFile, (event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('dsh desktop: bundle path must be a string')
    return transaction(event, () => manager.mutate({ type: 'bundle-install', source: { kind: 'file', path } }, hooks))
  })
  ipcMain.handle(DESKTOP_IPC.bundlesInstallUrl, (event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('dsh desktop: bundle URL must be a string')
    return transaction(event, () => manager.mutate({ type: 'bundle-install', source: { kind: 'url', url } }, hooks))
  })
  ipcMain.handle(DESKTOP_IPC.bundlesToggle, (event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('dsh desktop: invalid bundle activation request')
    return transaction(event, () => manager.mutate({ type: 'bundle-toggle', id, enabled }, hooks))
  })
  ipcMain.handle(DESKTOP_IPC.bundlesRemove, (event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('dsh desktop: bundle id must be a string')
    return transaction(event, () => manager.mutate({ type: 'bundle-remove', id }, hooks))
  })
  ipcMain.handle(DESKTOP_IPC.bundlesPickFile, async (event) => {
    assertDesktopSender(event, ['shell'])
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: messages.bundleFileFilter, extensions: [...BUNDLE_FILE_EXTENSIONS] }],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle(DESKTOP_IPC.backendStatus, (event) => {
    assertDesktopSender(event, ['shell'])
    return backendState()
  })
  ipcMain.handle(DESKTOP_IPC.backendRetry, async (event) => {
    assertDesktopSender(event, ['shell'])
    await reconcileBackend()
    focusPrimaryWindow()
  })
  ipcMain.handle(DESKTOP_IPC.diagnosticsGet, (event) => {
    assertDesktopSender(event, ['shell'])
    const state = backendState()
    let dshVersion: string
    try {
      dshVersion = manager.dshVersion()
    } catch {
      // The runtime descriptor is unknown until startup reads it; diagnostics still work.
      dshVersion = messages.diagnosticsUnknown
    }
    return assembleDesktopDiagnostics({
      applicationVersion: app.getVersion(),
      dshVersion,
      harnessHome: paths.root,
      runtimeLocation: resources.dsh,
      failure: state.phase === 'error' ? state.message : undefined,
    }, messages)
  })
  ipcMain.handle(DESKTOP_IPC.diagnosticsReveal, async (event) => {
    assertDesktopSender(event, ['shell'])
    const failure = await shell.openPath(paths.root)
    if (failure !== '') throw new Error(formatDesktopMessage(messages.diagnosticsRevealFailed, { message: failure }))
  })
  ipcMain.handle(DESKTOP_IPC.applicationRestart, async (event) => {
    assertDesktopSender(event, ['shell'])
    try {
      await recoverApplication('restart')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.configurationReset, async (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) throw new Error('Desktop configuration reset requires a packaged application')
    const failure = backendState()
    if (failure.phase !== 'error') {
      throw new Error('Desktop profile reset requires a startup failure')
    }
    await startup?.catch(() => undefined)
    try {
      await recoverApplication('reset')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertDesktopSender(event, ['shell'])
    return updates.check()
  })
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    assertDesktopSender(event, ['shell'])
    await updates.install()
  })

  const checkAndPrompt = async (manual: boolean): Promise<void> => {
    const state = await updates.check()
    if (state.phase === 'error') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'error',
          title: messages.updateCheckFailedTitle,
          message: state.message ?? messages.unknownError,
        })
      }
      return
    }
    if (state.phase !== 'available') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: messages.updateCheckTitle,
          message: state.message ?? messages.updateCurrent,
        })
      }
      return
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: messages.updateTitle,
      message: formatDesktopMessage(messages.updateAvailable, { version: state.version ?? '' }),
      detail: messages.updateDetail,
      buttons: [messages.installAndRestart, messages.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response !== 0) return
    const installed = await updates.install()
    if (installed.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateFailedTitle,
        message: installed.message ?? messages.unknownError,
      })
    }
  }

  const openPluginWindow = (): void => {
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
      pluginWindow.focus()
      return
    }
    pluginWindow = createWindow(managementPreload)
    pluginWindow.setSize(900, 620)
    pluginWindow.setTitle(messages.pluginWindowTitle)
    pluginWindow.once('ready-to-show', () => { pluginWindow?.show() })
    pluginWindow.once('closed', () => { pluginWindow = undefined })
    void pluginWindow.loadURL(`${SCHEME}://shell/plugin-manager.html`)
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: process.platform === 'darwin' ? app.name : messages.application,
    submenu: [
      {
        label: development === undefined ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
        accelerator: 'CmdOrCtrl+,',
        enabled: development === undefined,
        click: openPluginWindow,
      },
      { label: messages.checkUpdatesMenu, click: () => { void checkAndPrompt(true) } },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]))

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true)
    mainWindow = window
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('preload-error', (_event, _path, error) => {
      void showEmergencyError(error).catch((failure: unknown) => { console.error(failure) })
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      emergencyDocument = false
      void showStartupError(new Error(`Desktop renderer exited: ${details.reason}`))
        .catch((failure: unknown) => { console.error(failure) })
    })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      createMainWindow()
      void navigateMain(backendState().phase === 'ready' ? applicationUrl : startupUrl)
        .catch((error: unknown) => { console.error(error) })
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit || quitting) return
    event.preventDefault()
    quitting = true
    void backend.close().catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  })

  mainWindow = createMainWindow()
  // The loading page is up before the first launch expands the runtime, so the expansion has
  // somewhere to report what it is doing.
  await navigateMain(startupUrl).catch((error: unknown) => { console.error(error) })
  if (development === undefined) {
    try {
      await expandRuntimeArchive(paths.closure, app.getVersion(), (progress) => {
        publishBackend({ phase: 'starting', runtime: progress })
      })
    } catch (error: unknown) {
      await showStartupError(error)
      return
    }
  }
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (quitting) return
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (mainWindow !== undefined && development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
  setTimeout(() => { void checkAndPrompt(false) }, 10_000)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  const window = BrowserWindow.getAllWindows()[0] ?? createWindow(fileURLToPath(new URL('./preload-app.cjs', import.meta.url)), true)
  window.once('closed', () => { app.quit() })
  await showEmergencyDocument(window, message)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
