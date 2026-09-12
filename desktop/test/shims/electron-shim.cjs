// Test shim standing in for the real `electron` module: `node_modules/electron`
// exports a path string, so main.js cannot be loaded by plain Node without one.
// Only the surface main.js touches is implemented; spawns are recorded instead
// of executed, so the aux launcher wiring is observable without a GUI.
const { EventEmitter } = require('node:events')
const path = require('node:path')

const calls = { spawns: [], opened: [], ipcHandlers: new Map(), ipcOn: new Map() }

// Resolves once main.js has finished its load phase (config + IPC wiring). The
// harness sets DSH_DESKTOP_TEST_STOP so main.js returns before createWindow(),
// which keeps the test off the window, the server probe and the spawn path.
const ready = new Promise((resolve) => {
  globalThis.__dshDesktopReady = resolve
})
calls.ready = ready

const appData = process.env.DSH_TEST_APPDATA || 'D:\\fake\\appData'

// The app path (shipped `config.json` source) is a caller-supplied directory so a
// test never reads the repository's real shipped config by accident.
const appPath = process.env.DSH_TEST_APPPATH || 'D:\\fake\\app'

const app = new EventEmitter()
app.isPackaged = false
// Resolve on the next macrotask so main.js can run its whole synchronous load
// phase (loadConfig plus the IPC wiring) before the harness asserts.
app.whenReady = () => new Promise((resolve) => {
  setTimeout(resolve, 0)
})
app.getAppPath = () => appPath
app.getPath = (name) => {
  if (name === 'userData') {
    // Mirror main.js: it pins userData to path.join(appData, 'dsh-desktop') only
    // when no --user-data-dir flag was given, so appData must already be the
    // pinned directory for getPath('userData') to agree with it.
    return path.join(appData, '')
  }
  return appData
}
app.setPath = () => {}
app.requestSingleInstanceLock = () => true
app.quit = () => {}
app.exit = () => {}
app.setAppUserModelId = () => {}

class BrowserWindow {
  constructor() {
    this.webContents = {
      send: () => {},
      on: () => {},
      once: () => {},
      isLoading: () => false,
      getURL: () => '',
      setWindowOpenHandler: () => {},
    }
  }
  loadFile() { return Promise.resolve() }
  loadURL() { return Promise.resolve() }
  once() {}
  on() {}
  show() {}
  isDestroyed() { return false }
  setMenuBarVisibility() {}
}

const ipcMain = {
  handle: (channel, handler) => calls.ipcHandlers.set(channel, handler),
  on: (channel, handler) => calls.ipcOn.set(channel, handler),
}

const shell = {
  openExternal: (url) => calls.opened.push(url),
}

function dialog() {}
dialog.showErrorBox = () => {}

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  __calls: calls,
}
