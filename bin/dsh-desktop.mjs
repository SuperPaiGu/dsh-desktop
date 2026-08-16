#!/usr/bin/env node
/**
 * dsh-desktop CLI — 安装插件后即可使用的命令。
 *
 *   dsh-desktop                    启动桌面端（自带 exe 时；服务未跑会由 exe 自动拉起）
 *   dsh-desktop install [目录]     把随包附带的桌面 exe 复制到目标目录（默认桌面）
 *                                  并在真实桌面创建快捷方式——像普通 App 一样双击使用
 *
 * 仅 Windows：桌面 exe 与 Edge 应用窗口均为 Windows 形态。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findExe() {
  try {
    const dist = path.join(packageDir, 'desktop', 'dist')
    const file = readdirSync(dist).find((name) => /^DSH-Desktop-.*\.exe$/i.test(name))
    return file ? path.join(dist, file) : null
  } catch {
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

const command = process.argv[2] || 'run'

if (command === 'run') {
  if (process.platform !== 'win32') {
    console.error('dsh-desktop 当前版本仅支持 Windows。')
    process.exit(1)
  }
  const exe = findExe()
  if (!exe) {
    console.error('本次安装未附带桌面 exe（git 安装方式）。请在 Web UI 命令面板使用 /desktop（Edge 应用窗口），或从 Release 下载桌面 exe。')
    process.exit(1)
  }
  launchExe(exe, process.argv.slice(3))
  console.log(`已启动桌面程序（${exe}）`)
} else if (command === 'install') {
  if (process.platform !== 'win32') {
    console.error('dsh-desktop 当前版本仅支持 Windows。')
    process.exit(1)
  }
  const exe = findExe()
  if (!exe) {
    console.error('本次安装未附带桌面 exe，无法安装到桌面。')
    process.exit(1)
  }
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
