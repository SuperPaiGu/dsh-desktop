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
  readdirSync,
  writeFileSync,
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
const { chooseLauncher } = require('./launcher.js')
const { tokensFromLog, probeUrl } = require('./discovery.js')

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
    // Which CLI the main window's service runs:
    //   auto      — a deepseek-harness checkout when one exists, else installed
    //   installed — the installed CLI only, ignoring any checkout
    launcher: 'auto',
    startMode: 'auto', // auto | source | built (within a checkout)
    startupTimeoutMs: 120000,
    killAttachedOnExit: false, // when attaching, also stop the external server on window close
    auxPort: 3081, // port of the auxiliary instance
    auxHome: '', // '' shares dshHome; set a path to isolate the auxiliary instance
    // Log an externally started main service writes its own `dsh web:` line into.
    // '' selects <userData>/logs/dsh-main.log, which start-dsh-main.bat targets.
    mainServiceLog: '',
    window: { width: 1440, height: 900 },
  }
}

// Default checkout location, used only when config and env name no repository.
const DEFAULT_REPO_DIR = 'D:\\dsh\\deepseek-harness'

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

  // Later entries win, so the user file overrides the shipped defaults. It is
  // read in dev runs too: otherwise `electron .` silently ignores the same file
  // the packaged exe honours, and a setting that works in the exe looks broken
  // when the shell is run from source.
  const sources = [shipped, userFile]
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

// Repository candidate chain. `extra` lets a caller name a checkout before the
// shared config/env chain, so the source auxiliary instance can own its own repo
// without changing which checkout the main window spawns from.
function resolveRepoDirFor(extra) {
  if (extra && isRepoDir(extra)) return extra
  if (cfg.dshRepo && isRepoDir(cfg.dshRepo)) return cfg.dshRepo
  if (process.env.DSH_DESKTOP_REPO && isRepoDir(process.env.DSH_DESKTOP_REPO)) {
    return process.env.DSH_DESKTOP_REPO
  }
  if (isRepoDir(DEFAULT_REPO_DIR)) return DEFAULT_REPO_DIR
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
    const logDir = path.join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(path.join(logDir, 'dsh-desktop.log'), `${line}\n`)
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

// Since dsh 0.1.5 a web server authenticates the browser with a per-process
// launch token: the bare root URL answers 401 and its body is not the app, so a
// readiness probe that only fetches `/` would never see __DSH_BOOT__ and would
// time out against a perfectly healthy server. The token is printed once on the
// server's stdout, which spawnServer() tees into a log file; tokensFromFile()
// below reads that same line back out of every log this shell can reach.

/**
 * Ask one port whether a dsh web server is alive there.
 *
 * A 401 still means alive: since dsh 0.1.5 the bare root answers 401 until the
 * launch-token URL has minted a browser cookie, so treating it as "down" would
 * declare a healthy server unreachable. Alive-but-unauthorized is reported
 * separately so the caller can fetch a token instead of failing.
 * @param port - the port to probe.
 * @param token - the launch token when known; the probe then presents it.
 * @returns readiness, whether only authentication is missing, and the URL the
 * window should load — the tokenized one that answered, so its own request mints
 * the session cookie, or the bare root when only a 401 came back.
 */
async function probeDsh(port, token) {
  const url = probeUrl(port, token)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    clearTimeout(timer)
    const root = `http://127.0.0.1:${port}/`
    if (res.status === 401 || res.status === 403) {
      return { up: true, dsh: false, authRequired: true, url: root }
    }
    if (!res.ok) return { up: false }
    const body = await res.text()
    // Report the URL that actually answered, not the bare root: whenever a token
    // was presented this is the tokenized URL, and only a window that loads that
    // URL mints its own session cookie. This fetch's cookie lives in the main
    // process and is never handed to the window.
    return { up: true, dsh: body.includes(PROBE_MARKER), authRequired: false, url }
  } catch {
    return { up: false }
  }
}

// The launch token printed by the server this shell started, or by the one it
// attached to. The printed URL is the only handle on it.
function knownToken() {
  return tokenCandidates()[0] ?? null
}

/**
 * Log an externally started main service writes its own `dsh web:` line into.
 *
 * A window that only attaches cannot read the server's stdout, which is the one
 * place a launch token exists; the launcher script tees it here instead. An
 * explicit config path wins so a different launcher can name its own log without
 * rebuilding the shell.
 * @returns the configured log path, or the default under this app's userData.
 */
function mainServiceLogFile() {
  const configured = cfg && typeof cfg.mainServiceLog === 'string' ? cfg.mainServiceLog.trim() : ''
  return configured || path.join(app.getPath('userData'), 'logs', 'dsh-main.log')
}

/** Every token recorded in one log file, newest first. */
function tokensFromFile(file) {
  if (!file) return []
  try {
    return tokensFromLog(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Every launch token this shell holds a log handle on, most recent source first.
 *
 * A log accumulates one line per run, so its newest token may belong to a server
 * that has already exited; callers confirm a candidate against the live server
 * rather than trusting the newest line.
 * @returns distinct candidate tokens, newest source first.
 */
function tokenCandidates() {
  const out = []
  for (const file of [webLogFile, auxLogFile, mainServiceLogFile()]) {
    for (const token of tokensFromFile(file)) {
      if (!out.includes(token)) out.push(token)
    }
  }
  return out
}

/**
 * Whether a candidate token authenticates against the server on this port.
 *
 * The tokenized URL answers 3xx with a session cookie for the live token and 401
 * for anything else — but the redirect target is what needs that cookie, and this
 * process never stores one, so following the redirect collapses a good token into
 * the same 401 a wrong one gets. Stay on the first response and read it.
 * @param port - the port a `dsh web` server is listening on.
 * @param token - the candidate launch token.
 * @returns whether the server accepted this token.
 */
async function tokenAccepted(port, token) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(probeUrl(port, token), { signal: controller.signal, redirect: 'manual' })
    clearTimeout(timer)
    return res.status >= 300 && res.status < 400
  } catch {
    return false
  }
}

/**
 * The first candidate token the server on this port actually accepts.
 * @param port - the port a `dsh web` server may already be listening on.
 * @returns the working token, or null when no candidate authenticates.
 */
async function resolveWorkingToken(port) {
  for (const token of tokenCandidates()) {
    if (await tokenAccepted(port, token)) return token
  }
  return null
}

// The URL to load in the window: the tokenized one while a token is known, so
// the remote page's first request mints its cookie instead of landing on 401.
function windowUrl(port) {
  const token = knownToken()
  return token ? `${probeUrl(port, token)}` : `http://127.0.0.1:${port}/`
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
      // Pass the .cmd path as its own argv token, NOT pre-quoted: on Windows
      // libuv re-escapes embedded quotes, turning `"C:\...\dsh.cmd"` into a
      // literal `\"...\"` token that cmd /c cannot resolve. libuv quotes
      // spaced arguments itself, so an unquoted path is safe for all cases.
      command = 'cmd'
      args = ['/c', launcher.cmd, ...args]
    } else {
      command = launcher.cmd
    }
  }
  // The desktop window IS the UI, so never let the spawned `dsh web` also open
  // the default browser (it does unless --no-open is passed).
  args.push('--no-open')
  if (cfg.port !== DEFAULT_PORT) args.push('--port', String(cfg.port))
  const env = { ...process.env, DSH_HOME: cfg.dshHome }
  delete env.ELECTRON_RUN_AS_NODE
  logLine(`exec: ${command} ${args.join(' ')}`)
  logLine(`cwd: ${cwd}`)

  // Redirect the child's output to a file instead of pipes: piped stdio
  // backpressure can stall `dsh web` boot on Windows, file writes cannot.
  webLogFile = path.join(
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
  // Record it as ours so a later startup can tell its own leftover from a
  // server the user started by hand.
  recordSpawnedServer(child.pid, cfg.port)

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
    const probe = await probeDsh(cfg.port, knownToken())
    // `up` alone is the liveness signal: a 401 means the process is serving.
    if (!probe.up) {
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

async function enterAttach(url, token, authRequired) {
  logLine(`attached to running DSH server at ${url}`)
  // The attached server may require its launch token, which only its own log
  // carries; fall back to the bare root for servers that need none.
  if (authRequired && !token) {
    // Loading the bare root would paint an empty window with no explanation, so
    // name the missing piece and the two ways out instead.
    fail(
      `已在 ${url} 找到 dsh 服务，但它要求启动 token，而所有已知日志里都没有可用的那一串`
      + `（最后查找：${mainServiceLogFile()}）。`
      + '请用 start-dsh-main.bat 启动主服务（它会把 token 写进该文件），'
      + '或先停掉主服务，让桌面端自己启动服务。',
    )
    return false
  }  if (token) logLine('using the launch token recovered from a server log')
  setState({
    phase: 'ready',
    mode: 'attach',
    url: token ? probeUrl(cfg.port, token) : windowUrl(cfg.port),
  })
  startHealthMonitor()
  return true
}

// Windows command resolution for spawnSync/execFileSync, which do not consult
// PATHEXT: a bare name only works when an extensionless file exists next to it.
// npm installs the CLI as `dsh.cmd` plus an extensionless POSIX shell script, so
// probing the bare name resolves the shell script, which cmd.exe cannot run.
// Executable extensions come first and the exact name last, matching the order
// cmd.exe would use for a name it can actually execute.
function findOnPath(name) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
  const candidates = [...exts.map((ext) => name + ext), name]
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return null
}

// The installed-form CLI: an explicit override, the profile's healed .bin, or
// whatever Windows would run for `dsh` on PATH. Only the last step needs the
// spelling resolution, so a resolved path is returned ready to spawn.
function installedCliSpec() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const homeBin = path.join(cfg.dshHome, 'profiles', 'node_modules', '.bin')
  for (const name of ['dsh', 'dsh.CMD', 'dsh.cmd']) {
    const candidate = path.join(homeBin, name)
    if (existsSync(candidate)) return candidate
  }
  return findOnPath('dsh')
}

// The CLI the window's own service runs (see src/launcher.js for the rules).
function resolveLauncherFor() {
  const repo = resolveRepoDirFor('')
  return chooseLauncher({
    preference: cfg.launcher,
    repo: isRepoDir(repo) ? repo : null,
    decide: decideLaunch,
    installed: installedCliSpec(),
    report: logLine,
  })
}

// Log file of the most recent server spawn, so the readiness probe can recover
// the launch token the server prints once on stdout.
let webLogFile = ''

// The installed CLI: the explicit override, the profile's healed .bin, then the
// PATH entry Windows would run for `dsh`. Both the auxiliary instance and a
// window pinned with `launcher: installed` resolve through here.
function resolveInstalledLauncher() {
  const installed = installedCliSpec()
  return installed === null ? null : { kind: 'dsh-bin', cmd: installed }
}

async function enterSpawn() {
  setState({ phase: 'starting', mode: 'spawn' })
  const launcher = resolveLauncherFor()
  if (!launcher) {
    fail('未找到可用的 dsh CLI：既没有 deepseek-harness 检出，也没有已安装的 dsh。请在 config.json 设置 dshRepo，或设置环境变量 DSH_BIN。')
    return false
  }
  if (launcher.kind === 'checkout') {
    logLine(`spawning dsh web (${launcher.launch.kind} mode)`)
  } else {
    logLine(`spawning dsh web via installed CLI (${launcher.cmd})`)
  }
  serverChild = spawnServer(launcher)
  spawnedThisRun = true
  logLine(`spawned dsh web (pid ${serverChild.pid})`)

  const deadline = Date.now() + cfg.startupTimeoutMs
  let token = null
  while (Date.now() < deadline) {
    if (quitting || state.phase === 'server-down') return false
    // The token appears in the server's log a moment after it starts, so the
    // probe keeps re-reading it until the printed URL shows up.
    token = token || knownToken()
    const probe = await probeDsh(cfg.port, token)
    if (probe.up && (probe.dsh || probe.authRequired)) {
      const url = probe.dsh ? probe.url : probeUrl(cfg.port, token)
      // The server has bound the port by now, so this is where the listener id
      // the reclaim path matches on becomes known.
      recordSpawnedServer(serverChild === null ? null : serverChild.pid, cfg.port)
      setState({ phase: 'ready', url })
      startHealthMonitor()
      return true
    }
    await sleep(500)
  }
  fail(`等待 dsh web 就绪超时（${cfg.startupTimeoutMs}ms）`)
  return false
}

// ------------------------------------------------------- spawned-server record
// PIDs of the servers this shell spawned, written as it spawns them and cleared
// once they are stopped normally. A record that is still alive at the next
// startup therefore names a server whose launcher died without running its quit
// hooks — the one case where attaching cannot work, because the launch token
// died with the log nobody kept.
function spawnRecordFile() {
  return path.join(app.getPath('userData'), 'spawned-servers.json')
}

function readSpawnRecord() {
  try {
    const data = JSON.parse(readFileSync(spawnRecordFile(), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeSpawnRecord(record) {
  try {
    mkdirSync(path.dirname(spawnRecordFile()), { recursive: true })
    writeFileSync(spawnRecordFile(), JSON.stringify(record))
  } catch (error) {
    logLine(`spawn record write failed: ${error.message}`)
  }
}

/** Remember the processes that make up one spawned server. */
function recordSpawnedServer(childPid, port) {
  const record = readSpawnRecord()
  const existing = record[String(port)]
  record[String(port)] = {
    childPid: Number.isInteger(childPid) ? childPid : (existing ? existing.childPid : null),
    // The listener only exists once the server has bound the port, so the write
    // at spawn time is normally null; the ready path fills it in.
    listenerPid: findListenerPid(port),    startedAt: existing && Number.isInteger(existing.startedAt) ? existing.startedAt : Date.now(),
  }
  writeSpawnRecord(record)
}

/**
 * Whether a process is a `dsh web` server, judged by its command line.
 *
 * The last guard before killing a port holder this shell only infers from a
 * start time: whatever else may be listening, a replacement only follows a
 * process that actually runs dsh's web command.
 * @param pid - the process id to inspect.
 * @returns true when the command line names dsh and the web subcommand.
 */
function looksLikeDshWeb(pid) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
    ], { windowsHide: true, timeout: 5000 }).toString()
    return /dsh/i.test(out) && /\bweb\b/.test(out)
  } catch {
    return false
  }
}

/**
 * Whether a recorded process is still the one this shell spawned, judged by its
 * start time. A bare PID can be recycled by an unrelated process, which would
 * make a stale record look live.
 * @param pid - the recorded process id.
 * @param startedAt - the spawn time recorded beside it.
 * @returns true when the process exists and started close to that time.
 */
function recordedProcessMatches(pid, startedAt) {
  if (!pidAlive(pid)) return false
  if (!Number.isInteger(startedAt)) return true
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[int](Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue).StartTime.Subtract([datetime]'1970-01-01').TotalMilliseconds`,
    ], { windowsHide: true, timeout: 5000 }).toString().trim()
    const actual = Number.parseInt(out, 10)
    if (!Number.isFinite(actual)) return false
    // Process start is coarser than the record, so allow a wide window.
    return Math.abs(actual - startedAt) <= 120000
  } catch {
    return false
  }
}

/** Drop the record for a port once its server is known to be gone. */
function clearSpawnedServer(port) {
  const record = readSpawnRecord()
  if (record[String(port)] === undefined) return
  delete record[String(port)]
  writeSpawnRecord(record)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 probes liveness without touching the process.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Stop a server this shell spawned in an earlier, abnormally ended run.
 *
 * Runs before the attach probe so a leftover server is never mistaken for
 * someone else's. Only a PID recorded by this shell is touched; a server the
 * user started by hand has no record and is left alone.
 *
 * @returns true when a leftover server was found and stopped.
 */
function reclaimOwnOrphanedServer() {
  const record = readSpawnRecord()
  const entry = record[String(cfg.port)]
  if (entry === undefined) return false

  const listenerPid = findListenerPid(cfg.port)
  const recordedListener = Number.isInteger(entry.listenerPid) ? entry.listenerPid : null
  const recordedChild = Number.isInteger(entry.childPid) ? entry.childPid : null
  const startedAt = Number.isInteger(entry.startedAt) ? entry.startedAt : null

  if (listenerPid === null) {
    // Nothing holds the port, so there is nothing to reclaim.
    clearSpawnedServer(cfg.port)
    return false
  }

  // Identification must not depend on the launcher surviving: `cmd /c <dsh.cmd>`
  // may exit while the node server it started keeps serving, and then the only
  // recorded fact left is when we spawned it. So a listener counts as ours when
  // it is either the very process we recorded, or a dsh web server that started
  // no later than our spawn — a hand-started server predates the record, and a
  // recycled PID fails the start-time comparison.
  const listenerIsOurs = recordedListener !== null && listenerPid === recordedListener
  const portTakenByOurSuccessor = !listenerIsOurs
    && recordedProcessMatches(listenerPid, startedAt)
    && looksLikeDshWeb(listenerPid)

  if (!listenerIsOurs && !portTakenByOurSuccessor) {
    clearSpawnedServer(cfg.port)
    return false
  }

  logLine(
    `reclaiming a leftover server from an earlier run `
    + `(pid ${String(listenerPid)} on ${cfg.port}${listenerIsOurs ? '' : ', matched by start time'})`,
  )
  killProcessTree(listenerPid)
  // The listener may be a grandchild of `cmd /c`; the wrapper is harmless on its
  // own but leaving it running would leak a console-less shell per reclaimed run.
  if (recordedChild !== null && recordedChild !== listenerPid && pidAlive(recordedChild)) {
    try { killProcessTree(recordedChild) } catch {}
  }
  // The port needs a moment to be released before the replacement can bind it.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && findListenerPid(cfg.port) !== null) {
    spawnSync('cmd', ['/c', 'ping', '-n', '1', '-w', '200', '127.0.0.1'], { windowsHide: true })
  }
  clearSpawnedServer(cfg.port)
  return true
}

async function start() {
  setState({
    phase: 'starting',
    port: cfg.port,
    url: windowUrl(cfg.port),
    error: null,
  })
  if (!flags.forceSpawn) {
    // A window close is not guaranteed to run this process's quit hooks (a kill,
    // a crash, or a sign-out skips them), and the server this shell spawned is
    // detached from its launcher by the `cmd /c` wrapper. When that happens the
    // server survives with a launch token that lives only in a log nobody
    // remembers, and attaching to it can only fail. Reclaim it instead: a
    // server recorded as spawned by an earlier instance of this shell is ours
    // to stop, and stopping it is exactly what the user would do by hand.
    if (reclaimOwnOrphanedServer()) {
      // The port is free again; fall through and spawn a fresh server.
    } else {
      // A server may already be running. Confirm any token we hold a log handle
      // on against it first: the newest line in a log can belong to a dead run,
      // and a stale token would load a 401 page instead of the UI.
      const token = await resolveWorkingToken(cfg.port)
      const probe = await probeDsh(cfg.port, token)
      if (probe.up && (probe.dsh || probe.authRequired)) {
        return enterAttach(probe.url, token, probe.authRequired)
      }
      if (probe.up) {
        logLine(`port ${cfg.port} is busy but not a DSH server; attempting to spawn dsh web anyway`)
      }
    }
  }
  return enterSpawn()
}

// ---------------------------------------------------------------- quit flow
function gracefulStopServer(then) {
  const child = serverChild
  stopHealthMonitor()
  if (!child) {
    // The `cmd /c` wrapper can exit while the grandchild server keeps serving, and
    // the exit handler nulls `serverChild` when it does. The port is then still
    // ours to release even though nothing here names the process holding it.
    if (spawnedThisRun) {
      const listenerPid = findListenerPid(cfg.port)
      if (listenerPid !== null) {
        logLine(`stopping dsh web (wrapper gone; killing listener ${listenerPid} by port)`)
        try { killProcessTree(listenerPid) } catch {}
        clearSpawnedServer(cfg.port)
      }
    }
    then()
    return
  }
  let settled = false
  const finish = (code) => {
    if (settled) return
    settled = true
    serverStopped = true
    // The server is gone, so the record of it is spent.
    clearSpawnedServer(cfg.port)
    logLine(`dsh web stopped (code=${code})`)
    then()
  }
  child.once('exit', (code) => finish(code))
  // The child may be a `cmd /c` wrapper (installed-CLI path) whose real server
  // is a grandchild; killing the wrapper alone can orphan the server and leave
  // the port bound. Kill the listener by port first (authoritative, independent
  // of the wrapper chain), then the wrapper tree so no cmd shell survives.
  logLine('stopping dsh web (kill listener by port, then wrapper tree)…')
  const listenerPid = findListenerPid(cfg.port)
  if (listenerPid !== null && (!child || listenerPid !== child.pid)) {
    try { killProcessTree(listenerPid) } catch {}
  }
  try {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } catch {}
  setTimeout(() => finish('forced'), 4000)
}

let serverStopped = true
// True once this run has spawned a server, so quit-time cleanup still releases
// the port after the `cmd /c` wrapper exits and nulls `serverChild`.
let spawnedThisRun = false
let attachedKilled = false

// ------------------------------------------------------------ auxiliary instance
// A second, independent `dsh web` on its own port, started from the desktop
// window. It is NOT tied to the desktop's own server: the desktop spawns it
// detached, so closing or rebuilding the desktop never stops it. That is what
// makes "update the desktop while the auxiliary instance keeps running"
// possible.
//
// It always runs the installed CLI, never a checkout, so upgrading or rebuilding
// `deepseek-harness` cannot move it out from under the user.
const AUX_PORT_DEFAULT = 3081

// Log file of the most recent spawn, so the launch token can be read back for
// the "open" action.
let auxLogFile = ''

function auxPort() {
  return Number(cfg && cfg.auxPort) > 0 ? Number(cfg.auxPort) : AUX_PORT_DEFAULT
}

/**
 * The instance's DSH_HOME. An empty `auxHome` shares the desktop's own home
 * (same credentials, plugins, sessions). Point it at a path to isolate the
 * instance — required when it runs a different dsh version, whose session format
 * migration would otherwise rewrite this home's sessions.
 */
function auxHomeDir() {
  const configured = cfg && typeof cfg.auxHome === 'string' ? cfg.auxHome.trim() : ''
  return configured || (cfg && cfg.dshHome) || defaultConfig().dshHome
}

function auxState() {
  const port = auxPort()
  const pid = findListenerPid(port)
  return {
    port,
    running: pid !== null,
    pid,
    home: auxHomeDir(),
    logFile: auxLogFile,
  }
}

/** Spawn `dsh web` on the auxiliary port, detached so it outlives the desktop. */
function startAux() {
  const port = auxPort()
  if (findListenerPid(port) !== null) return { ok: true, already: true, ...auxState() }

  const launcher = resolveInstalledLauncher()
  if (!launcher) {
    return {
      ok: false,
      ...auxState(),
      message: '未找到已安装的 dsh CLI（先装 dsh，或设置 DSH_BIN）',
    }
  }

  let command
  let args
  let cwd = auxHomeDir()
  args = ['web', '--port', String(port), '--no-open']
  if (/\.cmd$/i.test(launcher.cmd)) {
    command = 'cmd'
    args = ['/c', launcher.cmd, ...args]
  } else {
    command = launcher.cmd
  }
  const env = { ...process.env, DSH_HOME: auxHomeDir() }
  delete env.ELECTRON_RUN_AS_NODE

  const logFile = path.join(
    app.getPath('userData'),
    'logs',
    `dsh-aux-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
  )
  auxLogFile = logFile
  let fd = -1
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    fd = openSync(logFile, 'a')
  } catch (error) {
    logLine(`aux: cannot open log: ${error.message}`)
  }
  logLine(`aux: starting ${command} ${args.join(' ')}`)
  logLine(`aux: home ${env.DSH_HOME} — log ${logFile}`)
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd > 0 ? fd : 'ignore', fd > 0 ? fd : 'ignore'],
    })
    child.on('error', (error) => logLine(`aux: spawn failed: ${error.message}`))
    child.unref()
    if (fd > 0) closeSync(fd)
  } catch (error) {
    if (fd > 0) closeSync(fd)
    return { ok: false, message: `启动失败: ${error.message}` }
  }
  return { ok: true, ...auxState() }
}

/** Stop whatever listens on the auxiliary port (and its process tree). */
function stopAux() {
  const port = auxPort()
  const pid = findListenerPid(port)
  if (pid === null) return { ok: true, already: true, ...auxState() }
  logLine(`aux: stopping listener ${pid} on ${port}`)
  try { killProcessTree(pid) } catch {}
  return { ok: true, ...auxState() }
}

/** Log files for the auxiliary instance, newest first by mtime. */
function auxLogFileCandidates() {
  const tracked = auxLogFile
  let files = []
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    files = readdirSync(dir)
      .filter((entry) => entry.startsWith('dsh-aux-') && entry.endsWith('.log'))
      .map((entry) => path.join(dir, entry))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {}
  return tracked && !files.includes(tracked) ? [tracked, ...files] : files
}

/**
 * The tokenized URL `dsh web` printed, or null.
 *
 * Since dsh 0.1.5 a web server authenticates the browser with a per-process
 * launch token: the bare root URL answers 401, and only the printed
 * `/?token=...` URL mints the session cookie before redirecting to `/`. The
 * token exists only in that process's stdout, which the desktop already
 * redirects into the instance's log file, so the log is the one place the shell
 * can recover it.
 */
function auxTokenUrl() {
  for (const file of auxLogFileCandidates()) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const matches = [...text.matchAll(/dsh web:\s*(http:\/\/\S+)/g)]
    const url = matches.at(-1)?.[1]
    if (url && url.includes('token=')) return url
  }
  return null
}

/** Open the auxiliary instance in the default browser, tokenized so it authenticates. */
function openAux() {
  const root = `http://127.0.0.1:${auxPort()}/`
  const url = auxTokenUrl()
  if (url) logLine('aux: opening tokenized URL from the instance log')
  else logLine('aux: no launch token in the log yet; opening the root URL')
  shell.openExternal(url || root)
  return auxState()
}

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
    if (state.phase === 'ready' && sameOrigin(url, state.url)) {
      remoteLoaded = true
      if (flags.smoke) setTimeout(() => finishSmoke(true), 1000)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    if (url && sameOrigin(url, state.url)) {
      fail(`页面加载失败: ${desc} (${code})`)
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

/**
 * Whether a loaded URL belongs to the page the window was handed.
 *
 * A plain prefix test is wrong once a launch token is involved: the tokenized
 * URL redirects to the bare root, so the finished URL never starts with the URL
 * that was requested. The origin is what stays stable across that redirect.
 * @param url - the URL the web contents reports.
 * @param target - the URL the window was told to load.
 * @returns whether both name the same origin.
 */
function sameOrigin(url, target) {
  try {
    return new URL(url).origin === new URL(target).origin
  } catch {
    return false
  }
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

ipcMain.handle('dsh:aux-status', () => auxState())
ipcMain.handle('dsh:aux-start', () => startAux())
ipcMain.handle('dsh:aux-stop', () => stopAux())
ipcMain.handle('dsh:aux-open', () => openAux())
// Re-read config.json without restarting. The shipped path only applies at
// startup, so this lets the auxiliary instance pick up an edited config
// immediately.
ipcMain.handle('dsh:reload-config', () => {
  cfg = loadConfig()
  return auxState()
})

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
    // The wrapper may have exited without the server going with it; release the
    // port anyway, because this run is the one that bound it.
    if (!serverChild && spawnedThisRun) {
      const listenerPid = findListenerPid(cfg.port)
      if (listenerPid !== null) {
        event.preventDefault()
        logLine(`stopping dsh web (wrapper gone; killing listener ${listenerPid} by port)`)
        killProcessTree(listenerPid)
        clearSpawnedServer(cfg.port)
        setTimeout(() => app.exit(0), 600)
        return
      }
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
    // Test seam: the stub harness loads this file to exercise config loading and
    // the IPC wiring only, then stops the startup here instead of opening a window.
    if (process.env.DSH_DESKTOP_TEST_STOP === '1') {
      globalThis.__dshDesktopReady?.()
      return
    }
    mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true })
    logLine(`dsh-desktop starting (electron ${process.versions.electron}, node ${process.versions.node})`)
    createWindow()
    if (flags.smoke) {
      setTimeout(() => finishSmoke(false), SMOKE_DEADLINE_MS)
    }
    start().catch((error) => fail(error.message))
  })
}
