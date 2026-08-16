/**
 * dsh-desktop host plugin: registers the human-facing `/desktop` command.
 *
 * The command opens the DeepSeek Harness web UI in a native desktop window:
 *   - the bundled portable exe when this package ships one
 *     (npm publish / tarball installs include desktop/dist/*.exe), else
 *   - a chromeless Edge app window (zero-dependency fallback, e.g. git installs).
 *
 * The window attaches to the already-running web server, so the desktop view
 * shows the exact same interface and sessions as the browser.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'desktop'
export const inject = ['commands']

const packageDir = path.dirname(fileURLToPath(import.meta.url))

/** The bundled portable exe, or null when this install does not ship one. */
function findDesktopExe() {
  try {
    const dist = path.join(packageDir, 'desktop', 'dist')
    const file = readdirSync(dist).find((entry) => /^DSH-Desktop-.*\.exe$/i.test(entry))
    return file ? path.join(dist, file) : null
  } catch {
    return null
  }
}

/** Detached spawn that survives the dsh process and stays console-free. */
function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (error) => {
    console.error(`[dsh-desktop] failed to spawn ${command}: ${error.message}`)
  })
  child.unref()
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'desktop',
    description: '在独立桌面窗口中打开 DeepSeek Harness（与 Web 界面一致）',
    handler() {
      if (process.platform !== 'win32') {
        return { kind: 'error', text: 'dsh-desktop 当前版本仅支持 Windows（Electron exe 与 Edge 应用窗口均为 Windows 形态）' }
      }
      const port = ctx.get('webStartup')?.port ?? 3080
      const url = `http://127.0.0.1:${port}/`
      const exe = findDesktopExe()
      if (exe) {
        spawnDetached(exe, [])
        return { kind: 'success', text: `已启动桌面窗口（${exe}）` }
      }
      // No bundled exe: fall back to Edge's app window, available on Windows 10/11.
      spawnDetached('cmd', [
        '/c', 'start', '', 'msedge',
        `--app=${url}`,
        '--window-size=1440,900',
        '--window-position=120,80',
      ])
      return { kind: 'success', text: `未附带桌面程序，已用 Edge 应用窗口打开 ${url}` }
    },
  })
  console.log('[dsh-desktop] /desktop command registered')
}
