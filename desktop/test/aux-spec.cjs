/**
 * Stub test for the desktop shell's two auxiliary instances.
 *
 * Loads the real src/main.js against a fake `electron` module and a fake
 * child_process/netstat, then asserts the wiring the renderer depends on:
 * per-instance ports and homes, the launcher each instance resolves, the spawn
 * argv/env it produces, and the IPC channel routing. Run with:
 *
 *   node test/aux.test.cjs
 */
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Module = require('node:module')

const REPO = 'D:\\dsh\\deepseek-harness'
const ISOLATED_HOME = 'D:\\dsh\\.dsh-015'

// The npm instance's launcher lives in the profile's `.bin`; this machine's real
// profile `.bin` is empty, so the test supplies one to exercise the `cmd /c
// <dsh.cmd>` branch instead of the PATH fallback.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-home-'))
const REAL_HOME = path.join(TEST_HOME, '.dsh')
const DSH_CMD = path.join(REAL_HOME, 'profiles', 'node_modules', '.bin', 'dsh.cmd')
fs.mkdirSync(path.dirname(DSH_CMD), { recursive: true })
fs.writeFileSync(DSH_CMD, '@echo off\r\n')

// A real userData tree: main.js pins userData to `path.join(appData, '')` and
// then mkdirSyncs `logs` under it, so the directory must exist on disk. The
// window config is a real file too — no fs mocking anywhere.
const APP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'))
const USER_DATA = path.join(APP_DATA, '')
const USER_CONFIG = path.join(USER_DATA, 'config.json')
const userConfig = {
  dshRepo: '',
  port: 3080,
  dshHome: REAL_HOME,
  startMode: 'auto',
  startupTimeoutMs: 120000,
  auxPort: 3081,
  auxHome: '',
  auxSourcePort: 3082,
  auxSourceHome: ISOLATED_HOME,
  auxSourceRepo: REPO,
}
fs.mkdirSync(USER_DATA, { recursive: true })

/** Write the window config the shell reads, then reload it in-process. */
function writeConfig(overrides = {}) {
  Object.assign(userConfig, baseConfig, overrides)
  fs.writeFileSync(USER_CONFIG, JSON.stringify(userConfig, null, 2))
  if (reloadConfig) reloadConfig()
}
let reloadConfig = null
const baseConfig = { ...userConfig }
process.env.DSH_TEST_USERDATA = USER_DATA
process.env.DSH_TEST_APPDATA = APP_DATA
// A directory with no shipped config.json, so only the test's config is read.
const APP_PATH = path.join(APP_DATA, 'app')
fs.mkdirSync(APP_PATH, { recursive: true })
process.env.DSH_TEST_APPPATH = APP_PATH
// main.js returns right after the load phase instead of opening a window.
process.env.DSH_DESKTOP_TEST_STOP = '1'

// ---------------------------------------------------------------- fakes
const spawns = []
const childProcess = require('node:child_process')
const realSpawnSync = childProcess.spawnSync
const realExecFileSync = childProcess.execFileSync
childProcess.spawnSync = (command, args, options) => {
  // netstat/taskkill helpers only: the CLI probe resolves through PATH now.
  if (command === 'netstat') return { status: 0, stdout: '', stderr: '' }
  if (command === 'taskkill') return { status: 0, stdout: '', stderr: '' }
  return realSpawnSync(command, args, options)
}
childProcess.execFileSync = (command, args) => {
  if (command === 'netstat') return ''
  return realExecFileSync(command, args)
}
childProcess.spawn = (command, args, options) => {
  spawns.push({ kind: 'spawn', command, args, options })
  const child = new (require('node:events').EventEmitter)()
  child.pid = 4242
  child.unref = () => {}
  return child
}

// ---------------------------------------------------------------- load main.js
// The config must be on disk before main.js loads: it reads the file itself.
writeConfig()
const electronic = require('./shims/electron-shim.cjs')
const realResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./shims/electron-shim.cjs')
  return realResolve.call(this, request, ...rest)
}
require('../src/main.js')
Module._resolveFilename = realResolve

const { __calls: calls } = electronic
// ipcMain.handle callbacks are (event, ...args); the event is not the kind.
const handler = (channel) => {
  const found = calls.ipcHandlers.get(channel)
  assert.ok(found, `missing IPC handler: ${channel}`)
  return (...args) => found({}, ...args)
}
reloadConfig = handler('dsh:reload-config')

// ---------------------------------------------------------------- assertions
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('status reports the single auxiliary instance', () => {
  const state = handler('dsh:aux-status')()
  assert.strictEqual(state.port, 3081)
  assert.strictEqual(state.home, REAL_HOME)
  assert.strictEqual(state.running, false)
  assert.strictEqual(typeof state.logFile, 'string')
})

test('start spawns the installed CLI through cmd, never the checkout', () => {
  spawns.length = 0
  handler('dsh:aux-start')()
  const spawn = spawns.find((entry) => entry.kind === 'spawn')
  assert.ok(spawn, 'no spawn happened')
  assert.strictEqual(spawn.command, 'cmd', 'a .cmd launcher must go through cmd /c')
  assert.strictEqual(spawn.args[0], '/c')
  // The probe accepts dsh / dsh.CMD / dsh.cmd; Windows paths compare case-insensitively.
  assert.strictEqual(spawn.args[1].toLowerCase(), DSH_CMD.toLowerCase())
  assert.deepStrictEqual(spawn.args.slice(2), ['web', '--port', '3081', '--no-open'])
  assert.strictEqual(spawn.options.env.DSH_HOME, REAL_HOME)
  assert.ok(!JSON.stringify(spawn.args).includes(REPO), 'the auxiliary instance must not touch the checkout')
  assert.strictEqual(spawn.options.cwd, REAL_HOME)
  assert.strictEqual(spawn.options.detached, true, 'the instance must outlive the desktop')
})

test('start falls back to the CLI resolved on PATH, spelled as Windows runs it', () => {
  // Windows does not consult PATHEXT for spawnSync, so a bare `dsh` fails with
  // ENOENT even though `dsh` works in a terminal. npm also ships an extensionless
  // POSIX shell script, which cmd.exe cannot run, so `.cmd` must win.
  const savedHome = baseConfig.dshHome
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-path-'))
  fs.writeFileSync(path.join(binDir, 'dsh'), '#!/bin/sh\n') // the POSIX script
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\r\n')
  const savedPath = process.env.PATH
  process.env.PATH = binDir
  spawns.length = 0
  try {
    writeConfig({ dshHome: path.join(TEST_HOME, 'no-profile-home') })
    handler('dsh:aux-start')()
    const spawn = spawns.find((entry) => entry.kind === 'spawn')
    assert.ok(spawn, 'no spawn happened')
    assert.strictEqual(spawn.command, 'cmd', 'the resolved .cmd must go through cmd /c')
    assert.strictEqual(spawn.args[1].toLowerCase(), path.join(binDir, 'dsh.cmd').toLowerCase())
    assert.deepStrictEqual(spawn.args.slice(2), ['web', '--port', '3081', '--no-open'])
  } finally {
    process.env.PATH = savedPath
    writeConfig({ dshHome: savedHome })
  }
})

test('start reports a missing CLI instead of spawning nothing', () => {
  const savedHome = baseConfig.dshHome
  const savedPath = process.env.PATH
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-empty-'))
  spawns.length = 0
  try {
    writeConfig({ dshHome: path.join(TEST_HOME, 'no-profile-home') })
    const result = handler('dsh:aux-start')()
    assert.strictEqual(result.ok, false)
    assert.match(result.message, /dsh CLI/)
    assert.strictEqual(spawns.find((entry) => entry.kind === 'spawn'), undefined)
  } finally {
    process.env.PATH = savedPath
    writeConfig({ dshHome: savedHome })
  }
})

test('launcher: auto prefers a checkout, installed pins the CLI', () => {
  const { chooseLauncher } = require('../src/launcher.js')
  const decide = () => ({ kind: 'built', bin: path.join(REPO, 'apps', 'cli', 'lib', 'bin.js') })
  const installed = 'C:\\npm\\dsh.cmd'
  const reports = []
  const report = (text) => reports.push(text)

  // auto: the checkout wins when it exists (the historical behaviour).
  const auto = chooseLauncher({ preference: 'auto', repo: REPO, decide, installed, report })
  assert.strictEqual(auto.kind, 'checkout')
  assert.strictEqual(auto.repo, REPO)

  // installed: the checkout is ignored even though it exists and is runnable.
  const pinned = chooseLauncher({ preference: 'installed', repo: REPO, decide, installed, report })
  assert.deepStrictEqual(pinned, { kind: 'dsh-bin', cmd: installed })

  // auto with no checkout falls back to the installed CLI.
  const fallback = chooseLauncher({ preference: 'auto', repo: null, decide, installed, report })
  assert.deepStrictEqual(fallback, { kind: 'dsh-bin', cmd: installed })

  // checkout: no fallback, so a missing checkout fails loudly.
  const missing = chooseLauncher({ preference: 'checkout', repo: null, decide, installed, report })
  assert.strictEqual(missing, null)

  // A checkout that exists but cannot run still falls back under auto.
  const broken = chooseLauncher({
    preference: 'auto',
    repo: REPO,
    decide: () => { throw new Error('startMode=built but apps/cli/lib/bin.js is missing') },
    installed,
    report,
  })
  assert.deepStrictEqual(broken, { kind: 'dsh-bin', cmd: installed })

  // An unknown preference is treated as auto.
  const unknown = chooseLauncher({ preference: 'nonsense', repo: REPO, decide, installed, report })
  assert.strictEqual(unknown.kind, 'checkout')

  // No checkout and no installed CLI leaves nothing to run.
  const nothing = chooseLauncher({ preference: 'auto', repo: null, decide, installed: null, report })
  assert.strictEqual(nothing, null)
  assert.ok(reports.some((line) => line.includes('no deepseek-harness checkout')), 'the reason is reported')
})

test('open targets the tokenized URL dsh web printed, not the bare root', () => {
  // dsh >= 0.1.5 answers 401 on the bare root and mints its cookie only from the
  // launch-token URL, which exists only in the instance's redirected stdout.
  const logDir = path.join(USER_DATA, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, 'dsh-aux-source-2026-01-01T00-00-00-000Z.log')
  fs.writeFileSync(logFile, [
    '[dsh-desktop] /desktop command registered',
    'dsh web: http://127.0.0.1:3082/?token=TOKEN123',
    '',
  ].join('\n'))

  calls.opened.length = 0
  handler('dsh:aux-open')('source')
  assert.deepStrictEqual(calls.opened, ['http://127.0.0.1:3082/?token=TOKEN123'])
})

test('open falls back to the root URL when no instance log carries a token', () => {
  // A fresh userData with no logs: the shell must still open something.
  const logDir = path.join(USER_DATA, 'logs')
  for (const entry of fs.readdirSync(logDir)) {
    if (entry.startsWith('dsh-aux-')) fs.rmSync(path.join(logDir, entry), { force: true })
  }
  calls.opened.length = 0
  handler('dsh:aux-open')('npm')
  assert.deepStrictEqual(calls.opened, ['http://127.0.0.1:3081/'])
})

test('discovery: recovers the launch token a 0.1.5 server prints', () => {
  const { tokenFromUrl, tokenFromLog, probeUrl } = require('../src/discovery.js')

  // The token is only in this line, and only on the server's stdout.
  const log = [
    '[dsh-desktop] /desktop command registered',
    'GitHub MCP Server running on stdio',
    'dsh web: http://127.0.0.1:3080/?token=uxJOtdGYU6nxc7IkGZTkrtYzLgtMgIdbk8WivQHbVdQ',
    '',
  ].join('\n')
  assert.strictEqual(tokenFromLog(log), 'uxJOtdGYU6nxc7IkGZTkrtYzLgtMgIdbk8WivQHbVdQ')

  // A log appended across restarts: the newest server owns the valid token.
  assert.strictEqual(
    tokenFromLog(`${log}dsh web: http://127.0.0.1:3080/?token=SECOND\n`),
    'SECOND',
  )

  // Older dsh prints the bare URL: no token, so the probe uses the root.
  assert.strictEqual(tokenFromLog('dsh web: http://127.0.0.1:3080\n'), null)
  assert.strictEqual(tokenFromLog(''), null)
  assert.strictEqual(tokenFromLog(undefined), null)

  assert.strictEqual(tokenFromUrl('http://x/?token=aB%2Bc'), 'aB+c')
  assert.strictEqual(tokenFromUrl('http://x/'), null)

  assert.strictEqual(probeUrl(3080, 'abc'), 'http://127.0.0.1:3080/?token=abc')
  assert.strictEqual(probeUrl(3080, null), 'http://127.0.0.1:3080/')
})

test('discovery: every token in a log, newest first, so a stale line cannot shadow a live one', () => {
  const { tokensFromLog } = require('../src/discovery.js')
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=OLD',
    'dsh web: http://127.0.0.1:3080/?token=NEW',
    'dsh web: http://127.0.0.1:3080/?token=OLD',
    '',
  ].join('\n')

  // OLD is the last line yet its first occurrence came earlier: every candidate
  // survives, ordered by its newest occurrence, so the caller can validate them
  // against the running server instead of trusting the tail of the file.
  assert.deepStrictEqual(tokensFromLog(log), ['OLD', 'NEW'])
  assert.deepStrictEqual(tokensFromLog('nothing to find'), [])
  assert.deepStrictEqual(tokensFromLog(undefined), [])
})

test('attach: reads the launch token an externally started main service logged', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  // A window that merely attaches cannot read the server's stdout, so the main
  // launcher script tees it into mainServiceLog and the attach path consults it.
  assert.match(source, /mainServiceLog: ''/)
  assert.match(source, /'logs', 'dsh-main\.log'\)/)
  assert.match(source, /for \(const file of \[webLogFile, auxLogFile, mainServiceLogFile\(\)\]\)/)
  // The newest line of a log may belong to a dead run, so a candidate is only
  // used once the live server accepts it.
  assert.match(source, /const token = await resolveWorkingToken\(cfg\.port\)/)
  // A candidate is validated on the first hop: following the token redirect lands
  // on a request without the freshly minted cookie and reads as 401 for a token
  // that is in fact correct.
  assert.match(source, /redirect: 'manual'/)
  assert.match(source, /return res\.status >= 300 && res\.status < 400/)
})

test('attach: an untokenized window explains itself instead of painting 401 blank', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(source, /if \(authRequired && !token\) \{/)
  assert.match(source, /url: token \? probeUrl\(cfg\.port, token\) : windowUrl\(cfg\.port\)/)
})

test('attach: the window loads the tokenized URL, not the bare root it cannot read', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  // The readiness fetch keeps its cookie inside the main process, so a 200 on
  // the tokenized URL proves the token without authenticating the window: the
  // window has to visit that same URL. Reporting the bare `root` from a
  // successful probe is exactly what painted an empty 401 page.
  assert.match(
    source,
    /return \{ up: true, dsh: body\.includes\(PROBE_MARKER\), authRequired: false, url \}/,
  )
  assert.match(source, /const url = probe\.dsh \? probe\.url : probeUrl\(cfg\.port, token\)/)
})

test('attach: a tokenized URL that redirected to the root still counts as loaded', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  // `/?token=...` mints the cookie and redirects to `/`, so a prefix test against
  // the URL the window was handed never matches: the window would never count as
  // loaded and --smoke would call a healthy window a failure.
  assert.match(source, /if \(state\.phase === 'ready' && sameOrigin\(url, state\.url\)\)/)
  assert.match(source, /return new URL\(url\)\.origin === new URL\(target\)\.origin/)
})

test('discovery: a 401 counts as alive, not as a dead server', () => {
  // The startup loop treats probe.up as the readiness signal and requires
  // dsh || authRequired; only an unreachable port may fail the wait.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(source, /res\.status === 401 \|\| res\.status === 403/)
  assert.match(source, /return \{ up: true, dsh: false, authRequired: true, url: root \}/)
  assert.match(source, /if \(probe\.up && \(probe\.dsh \|\| probe\.authRequired\)\)/)
})

test('discovery: the health monitor tolerates an authenticated-only server', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  // `up` alone is the liveness signal: requiring `dsh` would kill a healthy
  // 0.1.5 attach after 20 seconds.
  assert.match(source, /const probe = await probeDsh\(cfg\.port, knownToken\(\)\)/)
  assert.match(source, /if \(!probe\.up\) \{/)
})

test('stop is a no-op when nothing listens, and reports the port', () => {
  const stopped = handler('dsh:aux-stop')()
  assert.strictEqual(stopped.ok, true)
  assert.strictEqual(stopped.already, true, 'netstat reports no listener in the harness')
  assert.strictEqual(stopped.port, 3081)
})

test('reclaim: a server this shell spawned and left behind is stopped, not attached', () => {
  // A window close that skips the quit hooks (kill / crash / sign-out) leaves the
  // detached server alive with a launch token only its own log had. Attaching to
  // it cannot work, so the next startup must recognize it as its own leftover.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(source, /function reclaimOwnOrphanedServer\(\)/)
  // Two ways to be ours: the very process we recorded …
  assert.match(source, /const listenerIsOurs = recordedListener !== null && listenerPid === recordedListener/)
  // … or a dsh web server that started no later than our spawn. The launcher's
  // survival must NOT be required: `cmd /c <dsh.cmd>` can exit while the node
  // server keeps serving, and that is exactly when reclaim has to work.
  assert.match(source, /const portTakenByOurSuccessor = !listenerIsOurs/)
  assert.match(source, /recordedProcessMatches\(listenerPid, startedAt\)/)
  assert.match(source, /looksLikeDshWeb\(listenerPid\)/)
  assert.ok(
    !/launcherStillAlive/.test(source),
    'reclaim must not depend on the launcher still running',
  )
  // It runs before the attach probe, so a leftover is never mistaken for a peer.
  const reclaimAt = source.indexOf('if (reclaimOwnOrphanedServer())')
  const probeAt = source.indexOf('const token = await resolveWorkingToken(cfg.port)')
  assert.ok(reclaimAt > 0 && probeAt > reclaimAt, 'reclaim must run before the attach probe')
})

test('reclaim: the listener id is filled in once the server has bound the port', () => {
  // Nothing listens at spawn time, so the record written then has a null listener
  // id; the ready path must fill it in, or reclaim can never match by identity.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(source, /recordSpawnedServer\(child\.pid, cfg\.port\)/)
  const ready = source.indexOf("setState({ phase: 'ready', url })")
  const fill = source.lastIndexOf('recordSpawnedServer(', ready)
  assert.ok(fill > 0 && fill < ready, 'the ready path records the listener before publishing ready')
  // The spawn-time write keeps the original start time rather than resetting it,
  // so the start-time comparison still measures from the real spawn.
  assert.match(source, /existing && Number\.isInteger\(existing\.startedAt\) \? existing\.startedAt : Date\.now\(\)/)
})

test('reclaim: the record is spent once the server stops normally', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  const stop = source.slice(source.indexOf('function gracefulStopServer'))
  assert.match(stop.slice(0, 900), /clearSpawnedServer\(cfg\.port\)/)
  // A hand-started server has no record and is never reclaimed.
  assert.match(source, /const entry = record\[String\(cfg\.port\)\]/)
})

// ---------------------------------------------------------------- run
async function main() {
  // Wait for main.js to finish its load phase (config + IPC wiring).
  await calls.ready

  let failed = 0
  for (const { name, fn } of tests) {
    try {
      fn()
      console.log(`  PASS  ${name}`)
    } catch (error) {
      failed += 1
      console.log(`  FAIL  ${name}`)
      console.log(`        ${error.message}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
