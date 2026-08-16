// Loading/error page logic. Talks to the main process only through the
// contextBridge API exposed by src/preload.js.
const $ = (id) => document.getElementById(id)

const PHASE_TEXT = {
  starting: '正在连接 DeepSeek Harness…',
  ready: '服务已就绪，正在打开界面…',
  'server-down': '无法连接 DSH 服务',
}

const MODE_TEXT = {
  attach: '已接入正在运行的 DSH 服务',
  spawn: '由桌面版自动启动的 DSH 服务',
}

const MAX_LOG_LINES = 200

function render(state) {
  $('status').textContent = PHASE_TEXT[state.phase] || state.phase
  $('detail').textContent = [
    `地址 ${state.url || '—'}`,
    `端口 ${state.port || '—'}`,
    state.mode ? MODE_TEXT[state.mode] || state.mode : '',
    state.repo ? `仓库 ${state.repo}` : '',
  ].filter(Boolean).join(' · ')

  const down = state.phase === 'server-down'
  $('actions').hidden = !down
  $('spawn-btn').hidden = !(down && state.mode === 'attach')
  $('error').textContent = down ? state.error || '' : ''
  $('spinner').style.display = down ? 'none' : 'block'
  $('hint').style.display = !down && state.mode === 'spawn' ? 'block' : 'none'
  if (down) $('log-box').classList.add('open')
}

function appendLog(line) {
  const box = $('log-lines')
  const node = document.createElement('div')
  node.textContent = line
  box.appendChild(node)
  while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstChild)
  $('log-box').scrollTop = $('log-box').scrollHeight
}

$('retry-btn').addEventListener('click', () => window.dshDesktop.retry())
$('spawn-btn').addEventListener('click', () => window.dshDesktop.spawn())
$('quit-btn').addEventListener('click', () => window.dshDesktop.quit())

window.dshDesktop.getState().then((state) => {
  render(state)
  ;(state.logs || []).forEach(appendLog)
})
window.dshDesktop.onState(render)
window.dshDesktop.onLog(appendLog)
