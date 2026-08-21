#!/usr/bin/env node
/**
 * dsh-desktop CLI — 安装插件后即可使用的命令。
 *
 *   dsh-desktop                    启动桌面端（服务未跑会由 exe 自动拉起）
 *   dsh-desktop install [目录]     把桌面 exe 放到目标目录（默认桌面）并在真实桌面创建快捷方式
 *
 * 桌面 exe 的获取顺序：
 *   1) 插件包内置 exe（tgz 渠道，desktop/dist/*.exe）
 *   2) 无内置时，从 GitHub Release 自动下载 DSH-Desktop-*.exe（git / npm 渠道）
 *
 * 仅 Windows：桌面 exe 与 Edge 应用窗口均为 Windows 形态。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'SuperPaiGu/dsh-desktop'

// 在插件包内置目录里找桌面 exe（tgz 渠道会随包附带）。
function findExe() {
  try {
    const dist = path.join(packageDir, 'desktop', 'dist')
    const file = readdirSync(dist).find((name) => /^DSH-Desktop-.*\.exe$/i.test(name))
    return file ? path.join(dist, file) : null
  } catch {
    return null
  }
}

// 从 GitHub 最新 Release 下载 DSH-Desktop-*.exe，保存到插件内置 dist 目录并返回路径。
// 私有仓库需通过环境变量 GITHUB_PERSONAL_ACCESS_TOKEN 提供 token。
async function downloadReleaseExe() {
  const headers = { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers })
  if (!relRes.ok) throw new Error(`无法获取 ${REPO} 最新 Release（HTTP ${relRes.status}）`)
  const release = await relRes.json()
  const asset = (release.assets || []).find((a) => /DSH-Desktop-.*\.exe$/i.test(a.name))
  if (!asset) throw new Error('最新 Release 中未找到 DSH-Desktop-*.exe 资产，请先在 GitHub Release 附上该 exe')

  const dl = await fetch(asset.browser_download_url, { headers })
  if (!dl.ok) throw new Error(`下载 exe 失败（HTTP ${dl.status}）`)
  const dist = path.join(packageDir, 'desktop', 'dist')
  mkdirSync(dist, { recursive: true })
  const target = path.join(dist, asset.name)
  const buf = Buffer.from(await dl.arrayBuffer())
  writeFileSync(target, buf)
  console.log(`已从 Release 下载: ${target}（${Math.round(buf.length / 1024 / 1024)} MB）`)
  return target
}

// 返回本地 exe；没有则尝试联网下载；仍失败返回 null。
async function ensureExe() {
  const local = findExe()
  if (local) return local
  try {
    return await downloadReleaseExe()
  } catch (error) {
    console.error(error.message)
    console.error('本次安装未附带桌面 exe，且自动下载失败。请检查网络，或从 GitHub Release 手动下载 DSH-Desktop-*.exe 放到插件 desktop/dist 目录。')
    return null
  }
}

function launchExe(exe, extraArgs) {
  const child = spawn(exe, extraArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (error) => console.error(`无法启动桌面程序: ${error.message}`))
  child.unref()
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('dsh-desktop 当前版本仅支持 Windows。')
    process.exit(1)
  }
  const command = process.argv[2] || 'run'

  if (command === 'run') {
    const exe = await ensureExe()
    if (!exe) process.exit(1)
    launchExe(exe, process.argv.slice(3))
    console.log(`已启动桌面程序（${exe}）`)
  } else if (command === 'install') {
    const exe = await ensureExe()
    if (!exe) process.exit(1)
    const targetDir = path.resolve(process.argv[3] || path.join(process.env.USERPROFILE, 'Desktop'))
    const noShortcut = process.argv.includes('--no-shortcut')
    mkdirSync(targetDir, { recursive: true })
    const target = path.join(targetDir, path.basename(exe))
    copyFileSync(exe, target)
    console.log(`exe 已复制到: ${target}`)

    if (noShortcut) {
      console.log('已跳过快捷方式创建（--no-shortcut）。')
    } else {
      // Shortcut on the real desktop (handles redirected desktop folders).
      const psScript = [
        "$d=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders').Desktop)",
        '$ws=New-Object -ComObject WScript.Shell',
        `$s=$ws.CreateShortcut((Join-Path $d 'DSH 桌面版.lnk'))`,
        `$s.TargetPath='${target.replace(/'/g, "''")}'`,
        `$s.WorkingDirectory='${targetDir.replace(/'/g, "''")}'`,
        `$s.IconLocation='${target.replace(/'/g, "''")},0'`,
        '$s.Save()',
      ].join('; ')
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true })
      if (ps.status === 0) {
        console.log('桌面快捷方式已创建（DSH 桌面版）。')
      } else {
        console.log('桌面快捷方式创建失败，可自行右键 exe → 发送到 → 桌面快捷方式。')
      }
    }
    console.log('使用方式：双击桌面图标；或终端运行 dsh-desktop。')
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log('用法:')
    console.log('  dsh-desktop                    启动桌面端（服务未跑时自动拉起）')
    console.log('  dsh-desktop run [额外参数]     同直接运行，参数透传给桌面程序')
    console.log('  dsh-desktop install [目录]     复制桌面 exe 到目标目录（默认桌面）并建快捷方式')
  } else {
    console.error(`未知命令: ${command}（可用: run / install / help）`)
    process.exit(1)
  }
}

main()
