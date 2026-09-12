/**
 * Electron main process for the desktop application.
 *
 * It owns exactly three things the harness cannot own for itself: the process
 * that runs the harness, the window that displays it, and the lifecycle that
 * connects them. The harness runs as a child rather than in this process for
 * the reasons [`desktop/docs/releases/v0.0.1/architecture.md`](../../docs/releases/v0.0.1/architecture.md)
 * records: the terminal capability loads a native addon eagerly, bare-specifier
 * plugin resolution needs Node internals, and the profile launcher installs a
 * handler that terminates the process it runs in.
 *
 * @module @deepseek-ai/dsh-desktop-shell
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { BrowserWindow, Menu, app, dialog, ipcMain } from 'electron'

/** Prefix of the child's readiness record; the rest of the line is its JSON payload. */
const READY_PREFIX = 'dsh-desktop-ready '

/** How long the child may take to report readiness before the shell calls it a failure. */
const READY_TIMEOUT_MS = 60_000

/** How long the child may take to exit after a stop request before it is killed. */
const STOP_GRACE_MS = 10_000

/** Bounded runtime-log retention, in lines. */
const LOG_LIMIT = 2_000

/** Environment variable naming a closure to use instead of the packaged one. */
const CLOSURE_ENV = 'DSH_DESKTOP_CLOSURE'

/**
 * Entry point inside the closure, relative to the closure root.
 *
 * The closure ships as one archive rather than a loose package tree, so this
 * path crosses into it. Electron's patched `fs` reads it transparently, which is
 * what lets the harness's Loader resolve plugins by bare name from inside the
 * archive; the files it cannot read from there — native addons and the
 * executables it spawns — sit in the sibling `.asar.unpacked` directory.
 */
const ENTRY_RELATIVE_PATH = 'harness.asar/node_modules/@deepseek-ai/dsh-desktop-app/lib/entry.js'

/**
 * The PTY spawn helper, inside the archive's unpacked sibling directory.
 *
 * `node-pty` launches this helper and locates it beside the prebuilt addon it
 * loaded, which is a path inside the archive; a process launch cannot execute
 * one, so the shell names the real file for the child instead. The variable is
 * the override [`patches/node-pty@1.1.0.patch`](../../../patches/node-pty@1.1.0.patch)
 * reads before falling back to that path. A development run boots from a loose
 * closure, where the fallback is already a real path and this file is absent.
 */
const PTY_HELPER_RELATIVE_PATH = `harness.asar.unpacked/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`

/** One readiness payload, as the desktop bundle reports it. */
interface Readiness {
  port: number
  url: string
  version: string
}

/** The child's stdio shape: no stdin, both output streams piped for the runtime log. */
type HarnessChild = ChildProcessByStdio<null, Readable, Readable>

let child: HarnessChild | undefined
let window: BrowserWindow | undefined
let readiness: Readiness | undefined
let stopping = false
const log: string[] = []

/**
 * Locate the directory the closure sits in.
 *
 * A packaged application ships it beside the other resources. A development run
 * names the build output directory through the environment, because the closure
 * is a build artifact and the shell cannot derive it from its own position in
 * the source tree.
 * @returns the absolute directory containing `harness.asar`.
 */
function resolveClosureDir(): string {
  const configured = process.env[CLOSURE_ENV]
  if (configured !== undefined && configured !== '') return configured
  return process.resourcesPath
}

/**
 * Resolve the user's login-shell `PATH`.
 *
 * macOS launches an application from the Finder with only the system
 * directories, so the agent's shell tool would not find anything the user
 * installed themselves, and that failure reads as the agent being broken rather
 * than as a missing path. Editor applications resolve it the same way.
 * @returns the login shell's PATH, or the inherited one when it cannot be read.
 */
function loginShellPath(): string {
  const inherited = process.env['PATH'] ?? ''
  const loginShell = process.env['SHELL']
  if (loginShell === undefined || loginShell === '') return inherited
  const probe = spawnSync(loginShell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000 })
  const resolved = probe.status === 0 ? (probe.stdout ?? '').trim() : ''
  return resolved === '' ? inherited : resolved
}

/** Append one line to the bounded runtime log and forward it to the window. */
function record(stream: 'stdout' | 'stderr', line: string): void {
  const entry = `[${stream}] ${line}`
  log.push(entry)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
  window?.webContents.send('runtime-log', entry)
}

/**
 * Start the harness child and resolve once it reports readiness.
 *
 * The child is this process re-entered as Node, which keeps one binary and one
 * signature in the bundle. `--expose-internals` is what lets the Loader resolve
 * bare plugin specifiers; without it the tree does not mount at all.
 * @returns the child's readiness record.
 */
function startHarness(): Promise<Readiness> {
  const closureDir = resolveClosureDir()
  const entry = join(closureDir, ENTRY_RELATIVE_PATH)
  if (!existsSync(entry)) throw new Error(`harness entry not found at ${entry}`)
  const ptyHelper = join(closureDir, PTY_HELPER_RELATIVE_PATH)

  const spawned = spawn(process.execPath, ['--expose-internals', entry], {
    env: {
      ...process.env,
      PATH: loginShellPath(),
      DSH_HOME: join(app.getPath('userData'), 'harness'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP_VERSION: app.getVersion(),
      ELECTRON_RUN_AS_NODE: '1',
      // Only in a packaged run: a loose closure has no archive for the helper
      // to be outside of, and pointing node-pty at a path that is not there
      // fails every terminal the way the archive path did.
      ...(existsSync(ptyHelper) ? { DSH_NODE_PTY_SPAWN_HELPER: ptyHelper } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: app.getPath('home'),
  })
  child = spawned

  return new Promise<Readiness>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`the harness did not report readiness within ${String(READY_TIMEOUT_MS)} ms`))
    }, READY_TIMEOUT_MS)

    const onChunk = (stream: 'stdout' | 'stderr', chunk: string): void => {
      for (const line of chunk.split('\n')) {
        if (line === '') continue
        record(stream, line)
        if (!line.startsWith(READY_PREFIX) || settled) continue
        try {
          settled = true
          clearTimeout(timer)
          resolve(JSON.parse(line.slice(READY_PREFIX.length)) as Readiness)
        } catch (error) {
          settled = false
          record('stderr', `malformed readiness record: ${String(error)}`)
        }
      }
    }

    spawned.stdout.setEncoding('utf8')
    spawned.stderr.setEncoding('utf8')
    spawned.stdout.on('data', (chunk: string) => { onChunk('stdout', chunk) })
    spawned.stderr.on('data', (chunk: string) => { onChunk('stderr', chunk) })

    spawned.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    spawned.on('exit', (code, signal) => {
      child = undefined
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`the harness exited before readiness (code ${String(code)}, signal ${String(signal)})`))
        return
      }
      // An unexpected exit after readiness is a failure the user must see: the
      // harness holds every session it was serving, so a blank window would be
      // the only other outcome.
      if (!stopping) reportCrash(code, signal)
    })
  })
}

/** Surface an unexpected harness exit without taking the application down with it. */
function reportCrash(code: number | null, signal: NodeJS.Signals | null): void {
  void dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness',
    message: `The harness stopped unexpectedly (code ${String(code)}, signal ${String(signal)}).`,
    detail: 'Restart it to continue. The captured runtime output is on the Window menu.',
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
  }).then((choice) => {
    if (choice.response === 0) void restartHarness()
    else app.quit()
  })
}

/** Ask the child to dispose its tree, then exit; kill it if it does not. */
async function stopHarness(): Promise<void> {
  const running = child
  if (running === undefined) return
  stopping = true
  const exited = new Promise<void>((resolve) => { running.once('exit', () => { resolve() }) })
  running.kill('SIGTERM')
  const timer = setTimeout(() => { running.kill('SIGKILL') }, STOP_GRACE_MS)
  await exited
  clearTimeout(timer)
}

/** Stop the current child, then start and attach a new one. */
async function restartHarness(): Promise<void> {
  await stopHarness()
  stopping = false
  try {
    readiness = await startHarness()
    await window?.loadURL(readiness.url)
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: 'DeepSeek Harness', message: String(error) })
  }
}

/** Create the window; it is shown once its first paint can complete. */
function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1_280,
    height: 840,
    minWidth: 640,
    minHeight: 480,
    show: false,
    // A normal title bar, not `hiddenInset`. Hiding the title bar removes the
    // only surface macOS gives the window to drag by, and the interface is the
    // shipped browser client, which declares no `-webkit-app-region: drag` —
    // it was built for a browser, where there is no window chrome to replace.
    // An inset bar would also overlay its traffic lights on the interface's own
    // top-left corner.
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  created.once('ready-to-show', () => { created.show() })
  window = created
  return created
}

/** Present the captured runtime output, which is otherwise invisible to a user without a terminal. */
async function showRuntimeLog(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title: 'Runtime Log',
    message: `Last ${String(log.length)} line(s) of harness output`,
    detail: log.length === 0 ? '(no runtime output yet)' : log.join('\n').slice(-4_000),
    buttons: ['OK'],
  })
}

/** The application menu: the items an interface with text inputs cannot work without. */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { label: 'Runtime Log', click: () => { void showRuntimeLog() } },
        { label: 'Restart Harness', click: () => { void restartHarness() } },
      ],
    },
  ]))
}

ipcMain.handle('runtime-log:read', () => log.join('\n'))
ipcMain.handle('app:version', () => app.getVersion())

// One application instance per machine: the harness holds process-local state and
// binds a port, so a second copy would interleave session writes for no benefit.
const primary = app.requestSingleInstanceLock()
if (!primary) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(async () => {
    installMenu()
    const created = createWindow()
    // Closing the window must not silently kill a turn in progress: the
    // application stays in the Dock and the harness keeps working.
    created.on('close', () => { window = undefined })
    try {
      readiness = await startHarness()
      await created.loadURL(readiness.url)
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'DeepSeek Harness',
        message: 'The harness failed to start.',
        detail: `${String(error)}\n\n${log.slice(-2_000).join('\n')}`,
      })
    }
  })

  app.on('activate', () => {
    if (window !== undefined) return
    void (async () => {
      const created = createWindow()
      if (readiness !== undefined) await created.loadURL(readiness.url)
    })()
  })

  // Quit is the only action that stops the harness, and it drains first so the
  // session log ends complete rather than truncated where the signal arrived.
  app.on('before-quit', (event) => {
    if (child === undefined || stopping) return
    event.preventDefault()
    void stopHarness().finally(() => { app.exit(0) })
  })

  app.on('window-all-closed', () => {})
}
