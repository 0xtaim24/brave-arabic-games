const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GAME_DIR_NAME = 'Scam With Your Friends';
const GAME_EXE = 'Scam With Your Friends.exe';
const DISCORD_URL = 'https://discord.gg/ZCxu8kXkS';
const ALLOWED_LINKS = new Set([DISCORD_URL]);

const userFile = () => path.join(app.getPath('userData'), 'user-overrides.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const resources = () => (app.isPackaged ? process.resourcesPath : __dirname);
const dataFile = () => path.join(resources(), 'data', 'overrides.ar.json');
const fixSource = () => (app.isPackaged ? path.join(process.resourcesPath, 'fix') : path.join(__dirname, 'plugin', 'dist'));

let win;
let busy = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 920, minHeight: 640,
    backgroundColor: '#080F1C', title: 'brave', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#080F1C', symbolColor: '#F4F6FF', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); openExternal(url); } });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function openExternal(url) {
  if (ALLOWED_LINKS.has(url)) shell.openExternal(url);
}

// ---- settings ---------------------------------------------------------------
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
}

// ---- engine -----------------------------------------------------------------
function engineCommand() {
  const packaged = path.join(process.resourcesPath || '', 'engine', 'patcher.exe');
  if (app.isPackaged && fs.existsSync(packaged)) return { cmd: packaged, args: [] };
  const dist = path.join(__dirname, 'engine', 'dist', 'patcher.exe');
  if (fs.existsSync(dist)) return { cmd: dist, args: [] };
  const venvPy = path.join(__dirname, 'engine', '.venv', 'Scripts', 'python.exe');
  return { cmd: fs.existsSync(venvPy) ? venvPy : 'python', args: ['-X', 'utf8', path.join(__dirname, 'engine', 'patcher.py')] };
}

function runEngine(args, onLog) {
  return new Promise((resolve) => {
    const { cmd, args: base } = engineCommand();
    const child = spawn(cmd, [...base, ...args], { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    let buf = '', last = null, err = '';
    const feed = (line) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        if (o.type === 'log') onLog && onLog(o.msg); else last = o;
      } catch { /* ignore non-json noise */ }
    };
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); const parts = buf.split('\n'); buf = parts.pop(); parts.forEach(feed); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: 'تعذّر تشغيل المحرك: ' + e.message }));
    child.on('close', () => { feed(buf); resolve(last || { ok: false, error: err.trim().split('\n').pop() || 'المحرك ما رجّع نتيجة' }); });
  });
}

function isGameRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/NH'], { windowsHide: true }, (e, so) => resolve(!e && so.toLowerCase().includes(GAME_EXE.toLowerCase())));
  });
}

// ---- Steam detection --------------------------------------------------------
function regSteamPath() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (e, so) => {
      const m = !e && /SteamPath\s+REG_SZ\s+(.+)/.exec(so);
      resolve(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

async function findGame() {
  const libs = new Set();
  const steam = await regSteamPath();
  if (steam) {
    libs.add(steam);
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
    } catch { /* no vdf */ }
  }
  for (const d of 'CDEFGH') { libs.add(`${d}:\\SteamLibrary`); libs.add(`${d}:\\Program Files (x86)\\Steam`); }
  for (const lib of libs) {
    const g = path.join(lib, 'steamapps', 'common', GAME_DIR_NAME);
    if (fs.existsSync(g)) return g;
  }
  return null;
}

// ---- auto update ------------------------------------------------------------
function setupUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  const send = (s) => win && win.webContents.send('update', s);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => send({ state: 'error' }));
  ipcMain.removeHandler('install-update');
  ipcMain.removeHandler('check-update');
  ipcMain.handle('install-update', () => { autoUpdater.quitAndInstall(); });
  ipcMain.handle('check-update', () => autoUpdater.checkForUpdates().catch(() => null));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => null), 4000);
}
ipcMain.handle('install-update', () => false);
ipcMain.handle('check-update', () => null);

// ---- IPC --------------------------------------------------------------------
ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, discord: DISCORD_URL }));
ipcMain.handle('get-settings', () => readSettings());
ipcMain.handle('save-settings', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('open-external', (_e, url) => openExternal(url));
ipcMain.handle('find-game', findGame);
ipcMain.handle('browse', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'اختر مجلد اللعبة' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('game-running', isGameRunning);
ipcMain.handle('detect', (_e, game) => runEngine(['detect', '--game', game]));
ipcMain.handle('status', (_e, game) => runEngine(['status', '--game', game]));
ipcMain.handle('analyze', (_e, game) => runEngine(['analyze', '--game', game]));
ipcMain.handle('export', (_e, game) => runEngine(['export', '--game', game]));

ipcMain.handle('apply', async (_e, game, o) => {
  if (busy) return { ok: false, error: 'فيه عملية شغّالة' };
  if (await isGameRunning()) return { ok: false, error: 'اللعبة شغّالة. أغلقها ثم حاول من جديد.' };
  busy = true;
  try {
    const files = [dataFile()];
    if (fs.existsSync(userFile())) files.push(userFile());
    const args = ['apply', '--game', game, '--overrides', ...files, '--dialect', o.dialect || 'gulf_saudi', '--fix-source', fixSource()];
    if (o.text) args.push('--text');
    if (o.prompts) args.push('--prompts');
    if (o.short) args.push('--short');
    if (o.threads) args.push('--threads', String(o.threads));
    if (o.fix) args.push('--fix');
    if (o.tts) args.push('--tts', '--tts-threads', String(o.ttsThreads || 4));
    if (o.stt) args.push('--stt', '--stt-helper', '--stt-threads', String(o.sttThreads || 6));
    if (o.prebuffer) args.push('--prebuffer', '--prebuffer-seconds', String(o.prebufferSeconds || 1));
    if (o.fastModels) args.push('--fast-models', path.join(app.getPath('userData'), 'models'));
    return await runEngine(args, (m) => win && win.webContents.send('log', m));
  } finally { busy = false; }
});

ipcMain.handle('restore', async (_e, game) => {
  if (await isGameRunning()) return { ok: false, error: 'اللعبة شغّالة. أغلقها ثم حاول من جديد.' };
  return runEngine(['restore', '--game', game, '--remove-backup'], (m) => win && win.webContents.send('log', m));
});

ipcMain.handle('get-user-overrides', () => { try { return JSON.parse(fs.readFileSync(userFile(), 'utf8')); } catch { return { Menu: {}, Controls: {} }; } });
ipcMain.handle('save-user-overrides', (_e, data) => { fs.mkdirSync(path.dirname(userFile()), { recursive: true }); fs.writeFileSync(userFile(), JSON.stringify(data, null, 2), 'utf8'); return true; });

app.whenReady().then(() => { createWindow(); setupUpdater(); });
app.on('window-all-closed', () => app.quit());
