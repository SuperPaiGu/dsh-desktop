// Minimal preload: bridges the loading page to the main process.
// sandbox:true keeps this restricted to contextBridge + ipcRenderer.
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
})
