// Minimal preload: bridges the loading page and the desktop window's pages to
// the main process, and mounts the floating "auxiliary instance" control.
// sandbox:true keeps this restricted to contextBridge + ipcRenderer + DOM.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('dsh:state', listener)
    return () => ipcRenderer.removeListener('dsh:state', listener)
  },
  onLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('dsh:log', listener)
    return () => ipcRenderer.removeListener('dsh:log', listener)
  },
  retry: () => ipcRenderer.send('dsh:retry'),
  spawn: () => ipcRenderer.send('dsh:spawn'),
  quit: () => ipcRenderer.send('dsh:quit'),
  auxStatus: () => ipcRenderer.invoke('dsh:aux-status'),
  auxStart: () => ipcRenderer.invoke('dsh:aux-start'),
  auxStop: () => ipcRenderer.invoke('dsh:aux-stop'),
  auxOpen: () => ipcRenderer.invoke('dsh:aux-open'),
})

// -------------------------------------------------------------- aux control
// A second, independent dsh instance on its own port, always started from the
// installed CLI so upgrading or rebuilding a deepseek-harness checkout cannot
// move it. This floating control starts/opens/stops it from inside the desktop
// window, so the main service on this window's port keeps running untouched.
const AUX_ROOT_ID = '__dsh_aux_control__'

function stylize(el, props) {
  for (const key of Object.keys(props)) el.style.setProperty(key, props[key])
}

function makeButton(label) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  stylize(button, {
    border: '1px solid rgba(120, 130, 150, 0.4)',
    background: '#1b2130',
    color: '#d7dbe4',
    'border-radius': '7px',
    padding: '5px 10px',
    cursor: 'pointer',
    flex: '1 1 auto',
    font: 'inherit',
  })
  return button
}

function setEnabled(button, enabled) {
  button.disabled = !enabled
  button.style.setProperty('opacity', enabled ? '1' : '0.4')
  button.style.setProperty('cursor', enabled ? 'pointer' : 'default')
}

function mountAuxControl() {
  if (!document.body) return
  if (document.getElementById(AUX_ROOT_ID)) return

  const root = document.createElement('div')
  root.id = AUX_ROOT_ID
  stylize(root, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    'z-index': '2147483000',
    'font-family': '"Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
    'font-size': '12px',
    'line-height': '1.5',
    'user-select': 'none',
  })

  const panel = document.createElement('div')
  stylize(panel, {
    position: 'absolute',
    right: '0',
    bottom: '38px',
    'min-width': '260px',
    background: 'rgba(17, 21, 28, 0.97)',
    border: '1px solid rgba(120, 130, 150, 0.35)',
    'border-radius': '10px',
    padding: '10px 12px',
    color: '#d7dbe4',
    'box-shadow': '0 10px 30px rgba(0, 0, 0, 0.45)',
    display: 'none',
  })

  const title = document.createElement('div')
  title.textContent = '辅助端'
  title.title = '从已安装的 dsh（npm）启动，重打包桌面端 / 改源码都不影响它'
  stylize(title, { margin: '0 0 4px', 'font-weight': '600' })

  const statusLine = document.createElement('div')
  stylize(statusLine, { margin: '0 0 2px' })

  const homeLine = document.createElement('div')
  stylize(homeLine, {
    color: '#8b93a7',
    'font-size': '11px',
    'word-break': 'break-all',
  })

  const messageLine = document.createElement('div')
  stylize(messageLine, {
    color: '#f0a3a3',
    'font-size': '11px',
    margin: '4px 0 0',
    display: 'none',
  })

  const row = document.createElement('div')
  stylize(row, { display: 'flex', gap: '6px', margin: '7px 0 0' })

  const startButton = makeButton('启动')
  const openButton = makeButton('打开')
  const stopButton = makeButton('停止')
  row.appendChild(startButton)
  row.appendChild(openButton)
  row.appendChild(stopButton)

  panel.appendChild(title)
  panel.appendChild(statusLine)
  panel.appendChild(homeLine)
  panel.appendChild(row)
  panel.appendChild(messageLine)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.textContent = '辅助端'
  toggle.title = '启动/管理独立端口的 dsh 实例（不影响当前端口的服务）'
  stylize(toggle, {
    border: '1px solid rgba(120, 130, 150, 0.45)',
    background: 'rgba(23, 28, 38, 0.92)',
    color: '#d7dbe4',
    'border-radius': '999px',
    padding: '6px 12px',
    cursor: 'pointer',
    font: 'inherit',
    'box-shadow': '0 4px 14px rgba(0, 0, 0, 0.35)',
  })

  function showMessage(text) {
    messageLine.textContent = text || ''
    messageLine.style.setProperty('display', text ? 'block' : 'none')
  }

  function apply(state) {
    if (!state) {
      statusLine.textContent = '状态未知'
      setEnabled(startButton, false)
      setEnabled(openButton, false)
      setEnabled(stopButton, false)
      return
    }
    statusLine.textContent = state.running
      ? `状态：运行中（pid ${state.pid}）`
      : '状态：未运行'
    homeLine.textContent = `端口 ${state.port} · home ${state.home}`
    setEnabled(startButton, !state.running)
    setEnabled(openButton, state.running)
    setEnabled(stopButton, state.running)
  }

  async function refresh() {
    let state = null
    try {
      state = await ipcRenderer.invoke('dsh:aux-status')
    } catch {
      state = null
    }
    apply(state)
  }

  async function start() {
    setEnabled(startButton, false)
    startButton.textContent = '启动中…'
    let result = null
    try {
      result = await ipcRenderer.invoke('dsh:aux-start')
    } catch (error) {
      result = { ok: false, message: String(error && error.message ? error.message : error) }
    }
    startButton.textContent = '启动'
    if (result && result.ok === false) {
      showMessage(result.message || '启动失败')
      apply(result)
      // A failed start names a port that is not listening, so keep 启动 usable.
      setEnabled(startButton, true)
      return
    }
    showMessage('')
    await refresh()
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    const show = panel.style.display === 'none'
    panel.style.setProperty('display', show ? 'block' : 'none')
    if (show) refresh()
  })
  startButton.addEventListener('click', (event) => {
    event.stopPropagation()
    start()
  })
  openButton.addEventListener('click', async (event) => {
    event.stopPropagation()
    await ipcRenderer.invoke('dsh:aux-open')
  })
  stopButton.addEventListener('click', async (event) => {
    event.stopPropagation()
    await ipcRenderer.invoke('dsh:aux-stop')
    showMessage('')
    await refresh()
  })
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) panel.style.setProperty('display', 'none')
  })

  root.appendChild(panel)
  root.appendChild(toggle)
  document.body.appendChild(root)
  refresh()
  setInterval(refresh, 5000)
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', mountAuxControl)
} else {
  mountAuxControl()
}
