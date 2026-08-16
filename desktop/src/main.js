/**
 * DSH 桌面版 — Electron main process.
 *
 * Wraps the DeepSeek Harness Web GUI in a native window. It is a read-only
 * user of the sibling `deepseek-harness` checkout:
 *
 *   - probes http://127.0.0.1:<port>/ for a `__DSH_BOOT__` marker,
 *   - attaches to a running DSH server (closing the window leaves it alone), or
 *   - spawns `dsh web` itself in the checkout (closing the window stops it).
 *
 * The window loads the exact same URL the browser would, so the interface is
 * identical to the Web GUI.
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const {
  existsSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  copyFileSync,
  openSync,
  closeSync,
  readSync,
  statSync,
} = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const APP_ID = 'com.deepseek.dsh.desktop'
const DEFAULT_PORT = 3080
const PROBE_MARKER = '__DSH_BOOT__'
const LOG_TAIL_MAX = 200
const SMOKE_DEADLINE_MS = 150000

// ---------------------------------------------------------------- CLI flags
function parseFlags(argv) {
  const flags = { smoke: false, forceSpawn: false, port: null, dshHome: null, killAttached: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--smoke') flags.smoke = 'exit'
    else if (arg.startsWith('--smoke=')) flags.smoke = arg.slice('--smoke='.length) || 'exit'
    else if (arg === '--force-spawn') flags.forceSpawn = true
    else if (arg === '--kill-attached') flags.killAttached = true
    else if (arg === '--port' && next) { flags.port = Number(next); i++ }
    else if (arg === '--dsh-home' && next) { flags.dshHome = next; i++ }
    else if (arg.startsWith('--user-data-dir=')) flags.userDataDir = arg.slice('--user-data-dir='.length)
  }
  return flags
}

const flags = parseFlags(process.argv.slice(1))

// An explicit user-data dir must take effect before the single-instance lock,
// which is keyed on the userData path; the pin below otherwise forces one
// shared dir for dev and packaged runs.
if (flags.userDataDir) {
  app.setPath('userData', flags.userDataDir)
}

// ------------------------------------------------------------------ config
function readJsonOrNull(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function defaultConfig() {
  return {
    dshRepo: '',
    port: DEFAULT_PORT,
    dshHome: path.join(os.homedir(), '.dsh'),
    startMode: 'auto', // auto | source | built
    startupTimeoutMs: 120000,
    killAttachedOnExit: false, // when attaching, also stop the external server on window close
    window: { width: 1440, height: 900 },
  }
}

function loadConfig() {
  const cfg = defaultConfig()
  const shipped = path.join(app.getAppPath(), 'config.json')
  const userFile = path.join(app.getPath('userData'), 'config.json')

  // Packaged runs copy the shipped config to userData on first launch so the
  // user can edit it (a file inside the asar archive is read-only).
  if (app.isPackaged && !existsSync(userFile) && existsSync(shipped)) {
    try {
      mkdirSync(path.dirname(userFile), { recursive: true })
      copyFileSync(shipped, userFile)
    } catch (error) {
      logLine(`config seed failed: ${error.message}`)
    }
  }

  const sources = app.isPackaged ? [shipped, userFile] : [shipped]
  for (const file of sources) {
    const data = readJsonOrNull(file)
    if (data && typeof data === 'object') Object.assign(cfg, data)
  }
  if (flags.port) cfg.port = flags.port
  if (flags.dshHome) cfg.dshHome = flags.dshHome
  if (flags.killAttached || process.env.DSH_DESKTOP_KILL_ATTACHED === '1') {
    cfg.killAttachedOnExit = true
  }
  if (!cfg.dshHome) cfg.dshHome = defaultConfig().dshHome
  return cfg
}

let cfg = null

function isRepoDir(dir) {
  if (!dir) return false
  return (
    existsSync(path.join(dir, 'apps', 'cli', 'src', 'bin.ts'))
    || existsSync(path.join(dir, 'apps', 'cli', 'lib', 'bin.js'))
  )
}

function resolveRepoDir() {
  if (cfg.dshRepo && isRepoDir(cfg.dshRepo)) return cfg.dshRepo
  if (process.env.DSH_DESKTOP_REPO && isRepoDir(process.env.DSH_DESKTOP_REPO)) {
    return process.env.DSH_DESKTOP_REPO
  }
  // Walk upward from the app dir (dev) and from the exe (packaged) looking for
  // a deepseek-harness checkout. The walk-up distances keep the packaged path
  // harmless: a checkout is used only for the spawn fallback.
  const starts = [app.getAppPath(), path.dirname(process.execPath)]
  let fallback = cfg.dshRepo
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'deepseek-harness')
      if (isRepoDir(candidate)) return candidate
      if (i === 0) fallback = fallback || candidate
      dir = path.dirname(dir)
    }
  }
  return fallback
}

// ---------------------------------------------------------------- state/log
const state = {
  phase: 'starting', // starting | ready | server-down
  mode: null, // attach | spawn
  port: DEFAULT_PORT,
  url: '',
  repo: '',
  error: null,
}
const logTail = []
let mainWindow = null
let serverChild = null
let healthTimer = null
let quitting = false
let remoteLoaded = false
let smokeSettled = false

function logLine(text) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const line = `[${stamp}] ${String(text).replace(/\r?\n$/, '')}`
  logTail.push(line)
  if (logTail.length > LOG_TAIL_MAX) logTail.shift()
  console.log(line)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:log', line)
  }
  try {
    appendFileSync(
      path.join(app.getPath('userData'), 'logs', 'dsh-desktop.log'),
      `${line}\n`,
    )
  } catch {}
}

function setState(patch) {
  Object.assign(state, patch)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:state', state)
  }
  if (state.phase === 'ready' && mainWindow && !remoteLoaded) gotoWeb()
  if (state.phase === 'server-down' && mainWindow && !mainWindow.isDestroyed()) {
    // Always return to the status page, whether the remote page is loaded,
    // failed to load, or never got the chance.
    const loadingUrl = pathToFileURL(path.join(__dirname, '..', 'loading.html')).href
    if (mainWindow.webContents.getURL() !== loadingUrl) {
      remoteLoaded = false
      mainWindow.loadFile(path.join(__dirname, '..', 'loading.html'))
    }
  }
}

function fail(message) {
  logLine(`error: ${message}`)
  setState({ phase: 'server-down', error: message })
  if (flags.smoke) finishSmoke(false)
}

// ---------------------------------------------------------------- probing
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeDsh(port) {
  const url = `http://127.0.0.1:${port}/`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { up: false }
    const body = await res.text()
    return { up: true, dsh: body.includes(PROBE_MARKER), url }
  } catch {
    return { up: false }
  }
}

// ---------------------------------------------------------------- server mgmt
function decideLaunch(repo) {
  const sourceBin = path.join(repo, 'apps', 'cli', 'src', 'bin.ts')
  const builtBin = path.join(repo, 'apps', 'cli', 'lib', 'bin.js')
  const tsxHook = path.join(repo, 'node_modules', 'tsx')
  const sourceOk = existsSync(sourceBin) && existsSync(tsxHook)
  const builtOk = existsSync(builtBin)
  if (cfg.startMode === 'source') {
    if (sourceOk) return { kind: 'source', bin: sourceBin }
    throw new Error('startMode=source but apps/cli/src/bin.ts or node_modules/tsx is missing')
  }
  if (cfg.startMode === 'built') {
    if (builtOk) return { kind: 'built', bin: builtBin }
    throw new Error('startMode=built but apps/cli/lib/bin.js is missing — run pnpm run build in deepseek-harness')
  }
  // auto: prefer the built CLI (boots in seconds); tsx source mode can take a
  // minute or more on this machine, so it is only a fallback.
  if (builtOk) return { kind: 'built', bin: builtBin }
  if (sourceOk) return { kind: 'source', bin: sourceBin }
  throw new Error('no runnable dsh CLI found — run pnpm run build in deepseek-harness')
}

function resolveNodeBin() {
  const candidates = [
    process.env.NODE_BIN,
    'node',
    'C:\\Program Files\\nodejs\\node.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { windowsHide: true })
    if (probe.status === 0) return candidate
  }
  return candidates[0]
}

// PID of the process currently LISTENING on the local port, or null.
function findListenerPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      timeout: 5000,
    }).toString()
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const match = line.match(/([\d.\[\]:]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (match && Number(match[2]) === port) return Number(match[3])
    }
  } catch (error) {
    logLine(`netstat failed: ${error.message}`)
  }
  return null
}

function killProcessTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return true
  } catch (error) {
    logLine(`taskkill failed: ${error.message}`)
    return false
  }
}

function spawnServer(launcher) {
  let command
  let args
  let cwd = cfg.dshHome || os.homedir()
  if (launcher.kind === 'checkout') {
    command = resolveNodeBin()
    args = launcher.launch.kind === 'source'
      ? ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web']
      : ['apps/cli/lib/bin.js', 'web']
    cwd = launcher.repo
  } else {
    // Installed-form dsh CLI. .CMD shims and pnpm's extensionless shims both
    // need cmd /c on Windows.
    args = ['web']
    if (/\.cmd$/i.test(launcher.cmd)) {
      command = 'cmd'
      args = ['/c', `"${launcher.cmd}"`, ...args]
    } else {
      command = launcher.cmd
    }
  }
  if (cfg.port !== DEFAULT_PORT) args.push('--port', String(cfg.port))
  const env = { ...process.env, DSH_HOME: cfg.dshHome }
  delete env.ELECTRON_RUN_AS_NODE
  logLine(`exec: ${command} ${args.join(' ')}`)
  logLine(`cwd: ${cwd}`)

  // Redirect the child's output to a file instead of pipes: piped stdio
  // backpressure can stall `dsh web` boot on Windows, file writes cannot.
  const webLogFile = path.join(
    app.getPath('userData'),
    'logs',
    `dsh-web-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
  )
  let stdoutFd = -1
  let stderrFd = -1
  try {
    stdoutFd = openSync(webLogFile, 'a')
    stderrFd = openSync(webLogFile, 'a')
  } catch (error) {
    logLine(`cannot open web log: ${error.message}`)
  }
  logLine(`web log: ${webLogFile}`)

  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', stdoutFd > 0 ? stdoutFd : 'ignore', stderrFd > 0 ? stderrFd : 'ignore'],
  })

  // Tail the file so the loading page still shows live dsh web output.
  let tailOffset = 0
  const tailTimer = setInterval(() => {
    try {
      const stat = statSync(webLogFile)
      if (stat.size <= tailOffset) return
      const fd = openSync(webLogFile, 'r')
      const buf = Buffer.alloc(Math.min(stat.size - tailOffset, 65536))
      readSync(fd, buf, 0, buf.length, tailOffset)
      closeSync(fd)
      tailOffset += buf.length
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) logLine(`[web] ${line}`)
      }
    } catch {}
  }, 700)

  child.on('error', (error) => {
    fail(`failed to launch dsh web: ${error.message}`)
  })
  child.on('exit', (code, signal) => {
    clearInterval(tailTimer)
    if (stdoutFd > 0) closeSync(stdoutFd)
    if (stderrFd > 0) closeSync(stderrFd)
    if (serverChild === child) serverChild = null
    if (quitting) return
    logLine(`dsh web exited (code=${code} signal=${signal})`)
    stopHealthMonitor()
    setState({ phase: 'server-down', error: `dsh web 已退出 (code=${code})` })
  })
  return child
}

function startHealthMonitor() {
  stopHealthMonitor()
  healthTimer = setInterval(async () => {
    if (quitting) return
    const probe = await probeDsh(cfg.port)
    if (!(probe.up && probe.dsh)) {
      logLine('health check failed: DSH server no longer reachable')
      stopHealthMonitor()
      setState({ phase: 'server-down', error: 'DSH 服务不可达（可能已被关闭）' })
    }
  }, 20000)
}

function stopHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
}

async function enterAttach(url) {
  logLine(`attached to running DSH server at ${url}`)
  setState({ phase: 'ready', mode: 'attach' })
  startHealthMonitor()
  return true
}

// One of:
//   { kind: 'checkout', launch, repo }   — source-checkout dsh CLI
//   { kind: 'dsh-bin', cmd }             — installed-form dsh CLI
// or null when no launcher exists.
function resolveLauncher() {
  // 1. A deepseek-harness checkout (config dshRepo, env, or walked up from the app).
  const repo = resolveRepoDir()
  if (isRepoDir(repo)) {
    try {
      const launch = decideLaunch(repo)
      return { kind: 'checkout', launch, repo }
    } catch (error) {
      logLine(`checkout launcher unavailable: ${error.message}`)
    }
  }
  // 2. Explicit override.
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) {
    return { kind: 'dsh-bin', cmd: process.env.DSH_BIN }
  }
  // 3. Installed-form dsh: the healed .bin fallback under the dsh home.
  const homeBin = path.join(cfg.dshHome, 'profiles', 'node_modules', '.bin')
  for (const name of ['dsh', 'dsh.CMD', 'dsh.cmd']) {
    const candidate = path.join(homeBin, name)
    if (existsSync(candidate)) return { kind: 'dsh-bin', cmd: candidate }
  }
  // 4. The dsh CLI on PATH.
  const probe = spawnSync('dsh', ['--version'], { windowsHide: true })
  if (probe.status === 0) return { kind: 'dsh-bin', cmd: 'dsh' }
  return null
}

async function enterSpawn() {
  setState({ phase: 'starting', mode: 'spawn' })
  const launcher = resolveLauncher()
  if (!launcher) {
    fail('未找到可用的 dsh CLI：既没有 deepseek-harness 检出，也没有已安装的 dsh。请在 config.json 设置 dshRepo，或设置环境变量 DSH_BIN。')
    return false
  }
  if (launcher.kind === 'checkout') {
    setState({ repo: launcher.repo })
    logLine(`spawning dsh web (${launcher.launch.kind} mode)`)
  } else {
    logLine(`spawning dsh web via installed CLI (${launcher.cmd})`)
  }
  serverChild = spawnServer(launcher)

  const deadline = Date.now() + cfg.startupTimeoutMs
  while (Date.now() < deadline) {
    if (quitting || state.phase === 'server-down') return false
    const probe = await probeDsh(cfg.port)
    if (probe.up && probe.dsh) {
      setState({ phase: 'ready' })
      startHealthMonitor()
      return true
    }
    await sleep(500)
  }
  fail(`等待 dsh web 就绪超时（${cfg.startupTimeoutMs}ms）`)
  return false
}

async function start() {
  setState({
    phase: 'starting',
    port: cfg.port,
    url: `http://127.0.0.1:${cfg.port}/`,
    error: null,
  })
  if (!flags.forceSpawn) {
    const probe = await probeDsh(cfg.port)
    if (probe.up && probe.dsh) return enterAttach(probe.url)
    if (probe.up) {
      logLine(`port ${cfg.port} is busy but not a DSH server; attempting to spawn dsh web anyway`)
    }
  }
  return enterSpawn()
}

// ---------------------------------------------------------------- quit flow
function gracefulStopServer(then) {
  const child = serverChild
  stopHealthMonitor()
  if (!child) { then(); return }
  let settled = false
  const finish = (code) => {
    if (settled) return
    settled = true
    serverStopped = true
    logLine(`dsh web stopped (code=${code})`)
    then()
  }
  child.once('exit', (code) => finish(code))
  logLine('stopping dsh web (SIGTERM)…')
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => {
    if (!settled) {
      logLine('graceful stop timed out — force killing process tree')
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {}
      setTimeout(() => finish('forced'), 1000)
    }
  }, 5000)
}

let serverStopped = true
let attachedKilled = false

// ---------------------------------------------------------------- window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    minWidth: 1024,
    minHeight: 680,
    show: !flags.smoke,
    title: 'DSH 桌面版',
    backgroundColor: '#0e1117',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, '..', 'loading.html'))
  mainWindow.once('ready-to-show', () => {
    if (!flags.smoke) mainWindow.show()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const base = `http://127.0.0.1:${cfg.port}`
    if (!url.startsWith(base) && !url.startsWith('file:')) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL()
    if (state.phase === 'ready' && url.startsWith(state.url)) {
      remoteLoaded = true
      if (flags.smoke) setTimeout(() => finishSmoke(true), 1000)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    if (url && url.startsWith(state.url)) {
      fail(`页面加载失败: ${desc} (${code})`)
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function gotoWeb() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const load = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.loadURL(state.url).catch((error) => {
      fail(`打开 ${state.url} 失败: ${error.message}`)
    })
  }
  // Serialize navigations: calling loadURL while the status page is still
  // loading aborts it with ERR_ABORTED (-3).
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', load)
  } else {
    load()
  }
}

// ---------------------------------------------------------------- smoke mode
function finishSmoke(ok) {
  if (smokeSettled) return
  smokeSettled = true
  console.log(`[dsh-desktop] SMOKE ${ok ? 'OK' : 'FAIL'} mode=${state.mode} phase=${state.phase}`)
  const code = ok ? 0 : 1
  if (serverChild) {
    serverStopped = false
    gracefulStopServer(() => app.exit(code))
    return
  }
  // --smoke=quit goes through the normal quit path so will-quit hooks
  // (e.g. killAttachedOnExit) are exercised in tests.
  if (flags.smoke === 'quit' && ok) {
    app.quit()
    return
  }
  app.exit(code)
}

// ---------------------------------------------------------------- ipc
ipcMain.handle('dsh:get-state', () => ({
  ...state,
  logs: logTail.slice(-40),
}))

ipcMain.on('dsh:retry', async () => {
  remoteLoaded = false
  const ok = await start()
  if (!ok) return
})

ipcMain.on('dsh:spawn', async () => {
  remoteLoaded = false
  await enterSpawn()
})

ipcMain.on('dsh:quit', () => app.quit())

// ---------------------------------------------------------------- lifecycle
app.setAppUserModelId(APP_ID)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', (event) => {
    if (serverChild && !serverStopped) {
      event.preventDefault()
      gracefulStopServer(() => app.exit(0))
      return
    }
    // Optional: when we attached to an externally started server, stop it too
    // on window close. Off by default — the external server may be hosting the
    // very conversation running this app's backend.
    if (state.mode === 'attach' && cfg && cfg.killAttachedOnExit && !attachedKilled) {
      attachedKilled = true
      event.preventDefault()
      const pid = findListenerPid(cfg.port)
      if (pid === null) {
        app.exit(0)
        return
      }
      logLine(`killAttachedOnExit: stopping attached DSH server (pid ${pid})`)
      killProcessTree(pid)
      setTimeout(() => app.exit(0), 600)
    }
  })
  app.on('window-all-closed', () => app.quit())

  app.whenReady().then(() => {
    // Pin userData so dev and packaged runs share the same config/log location,
    // unless the launcher supplied its own --user-data-dir.
    if (!flags.userDataDir) {
      app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop'))
    }
    cfg = loadConfig()
    mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true })
    logLine(`dsh-desktop starting (electron ${process.versions.electron}, node ${process.versions.node})`)
    createWindow()
    if (flags.smoke) {
      setTimeout(() => finishSmoke(false), SMOKE_DEADLINE_MS)
    }
    start().catch((error) => fail(error.message))
  })
}
