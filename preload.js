const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...a) => ipcRenderer.invoke(name, ...a);

contextBridge.exposeInMainWorld('api', {
  appInfo: call('app-info'),
  getSettings: call('get-settings'),
  saveSettings: call('save-settings'),
  openExternal: call('open-external'),
  findGame: call('find-game'),
  browse: call('browse'),
  gameRunning: call('game-running'),
  detect: call('detect'),
  status: call('status'),
  analyze: call('analyze'),
  exportRows: call('export'),
  apply: call('apply'),
  restore: call('restore'),
  getUser: call('get-user-overrides'),
  saveUser: call('save-user-overrides'),
  installUpdate: call('install-update'),
  checkUpdate: call('check-update'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});
