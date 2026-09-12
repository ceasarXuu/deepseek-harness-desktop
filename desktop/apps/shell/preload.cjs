// Preload: the one channel the interface needs from the shell. CommonJS because
// Electron loads preload scripts through its own require path, and the surface
// stays deliberately small — the renderer is the shipped browser client and
// needs nothing from the host beyond the runtime log.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  /** Read the captured harness output as one string. */
  readRuntimeLog: () => ipcRenderer.invoke('runtime-log:read'),
  /** The application version, shown by the About surface. */
  appVersion: () => ipcRenderer.invoke('app:version'),
  /** Subscribe to runtime-log lines as the harness writes them. */
  onRuntimeLog: (listener) => {
    const handler = (_event, line) => { listener(line) }
    ipcRenderer.on('runtime-log', handler)
    return () => { ipcRenderer.removeListener('runtime-log', handler) }
  },
})
