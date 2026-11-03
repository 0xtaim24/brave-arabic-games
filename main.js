const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStore } = require('./characters');

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
  // only this app's own page may use the microphone, and nothing else is granted
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details) => cb(permission === 'media' && (details.requestingUrl || '').startsWith('file://') && !(details.mediaTypes || []).includes('video')));
  win.webContents.session.setPermissionCheckHandler((wc, permission) => permission === 'media');
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
  autoUpdater.allowPrerelease = false;
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
  setInterval(() => autoUpdater.checkForUpdates().catch(() => null), 4 * 60 * 60 * 1000).unref();
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

// ---- models + custom voices --------------------------------------------------
const helperPath = () => path.join(fixSource(), 'supertts.exe');
const dataDir = () => path.join(resources(), 'data');
const voicesDir = () => path.join(app.getPath('userData'), 'voices');
ipcMain.handle('models', () => runEngine(['models']));
ipcMain.handle('models-auto', () => runEngine(['models-auto', '--helper', helperPath(), '--data-dir', dataDir()], (m) => win && win.webContents.send('log', m)));
const listVoices = () => { try { return fs.readdirSync(voicesDir()).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => f.replace(/\.json$/i, '')); } catch { return []; } };
ipcMain.handle('list-voices', () => listVoices());
ipcMain.handle('add-voice', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Supertonic voice style', extensions: ['json'] }], title: 'اختر ملف الصوت (.json)' });
  if (r.canceled || !r.filePaths[0]) return listVoices();
  try { JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch { return { error: 'الملف مو JSON صحيح' }; }
  fs.mkdirSync(voicesDir(), { recursive: true });
  fs.copyFileSync(r.filePaths[0], path.join(voicesDir(), path.basename(r.filePaths[0])));
  return listVoices();
});
ipcMain.handle('remove-voice', (_e, name) => { try { fs.unlinkSync(path.join(voicesDir(), path.basename(name) + '.json')); } catch { /* gone */ } return listVoices(); });

// ---- character profiles -----------------------------------------------------
const gameUserDir = () => path.join(os.homedir(), 'AppData', 'LocalLow', 'Jatater Worldwide', 'Scam With Your Friends');
const characterStore = () => createStore(path.join(app.getPath('userData'), 'characters'), path.join(gameUserDir(), 'Character Creator'));
const trialFile = () => path.join(app.getPath('userData'), 'character-trial.json');
function getTrial() { try { return JSON.parse(fs.readFileSync(trialFile(), 'utf8')); } catch { return null; } }
function characterCommand(flag, env, timeout = 180000) {
  return new Promise(resolve => {
    const command = sttHelperCommand();
    const child = spawn(command.cmd, [...command.args, flag], { cwd: command.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', ...env } });
    let output = '', error = '', expired = false;
    const timer = setTimeout(() => { expired = true; execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); }, timeout);
    child.stdout.on('data', d => { output = (output + d.toString('utf8')).slice(-50000); });
    child.stderr.on('data', d => { error = (error + d.toString('utf8')).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = output.split('\n').find(x => x.startsWith('OK '));
      try { resolve(line ? { ok: true, ...JSON.parse(line.slice(3)) } : { ok: false, error: expired ? 'استغرق تجهيز الصوت وقتًا طويلًا. جرّب صوتًا جاهزًا أو تسجيلًا أقصر.' : error.trim().split('\n').pop() || 'تعذّر تجهيز الصوت.' }); }
      catch { resolve({ ok: false, error: 'تعذّر قراءة نتيجة الصوت.' }); }
    });
  });
}
async function characterJob(job, gameMustBeClosed = false) {
  if (busy) return { ok: false, error: 'انتظر انتهاء العملية الحالية.' };
  if (gameMustBeClosed && await isGameRunning()) return { ok: false, error: 'أغلق اللعبة أولًا لتطبيق تغييرات الشخصيات.' };
  busy = true;
  try { await closeMicWorker(); return { ok: true, ...await job() }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { busy = false; }
}
ipcMain.handle('characters-list', () => {
  try { return { ok: true, characters: characterStore().list(), trial: getTrial()?.id || null }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('character-new', () => ({ ok: true, id: characterStore().allocate() }));
ipcMain.handle('character-image', (_e, id) => characterJob(async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'صورة الشخصية PNG', extensions: ['png'] }] });
  if (result.canceled) return { canceled: true };
  return { image: characterStore().image(id, fs.readFileSync(result.filePaths[0])) };
}));
ipcMain.handle('character-reference', (_e, id, consent) => characterJob(async () => {
  if (consent !== true) throw Error('أكد أن التسجيل صوتك أو أن صاحبه وافق على استنساخه.');
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'تسجيل صوتي', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }] });
  if (result.canceled) return { canceled: true };
  const directory = characterStore().dir(id), target = path.join(directory, 'reference.wav');
  const prepared = await characterCommand('--prepare-character-reference', { ARABICAI_REFERENCE_INPUT: result.filePaths[0], ARABICAI_REFERENCE_OUTPUT: target + '.tmp.wav' });
  if (!prepared.ok) throw Error(prepared.error);
  fs.renameSync(target + '.tmp.wav', target);
  characterStore().touch(id);
  return prepared;
}, true));
ipcMain.handle('character-save', (_e, value) => characterJob(async () => ({ character: characterStore().save(value) })));
ipcMain.handle('character-model-status', () => {
  const file = path.join(app.getPath('userData'), 'models', 'character-voice', 'Chatterbox-GGUF', 'chatterbox-q8_0.gguf');
  return { ok: true, installed: fs.existsSync(file) && fs.statSync(file).size === 2088399204 };
});
ipcMain.handle('character-model-download', () => characterJob(async () => {
  const result = await characterCommand('--download-character-model', {}, 30 * 60 * 1000);
  if (!result.ok) throw Error(result.error);
  return result;
}, true));
async function previewCharacter(id, game, text, targetName = 'preview.wav') {
  const store = characterStore(), p = store.read(id);
  const target = path.join(store.dir(id), targetName);
  const result = await characterCommand('--character-preview', { ARABICAI_CHARACTERS_DIR: store.root,
    ARABICAI_CHARACTER_ID: id, ARABICAI_GAME_DIR: game || '', ARABICAI_PREVIEW_TEXT: String(text || p.opening).slice(0,500),
    ARABICAI_PREVIEW_OUTPUT: target, SUPERTONIC_INTRA_OP_THREADS: '4' });
  if (!result.ok) throw Error(result.error);
  return { ...result, audio: fs.readFileSync(target).toString('base64'), cloned: p.voiceMode === 'clone' };
}
ipcMain.handle('character-preview', (_e, id, game, text) => characterJob(() => previewCharacter(id, game, text), true));
ipcMain.handle('character-install', (_e, id, game) => characterJob(async () => {
  const gameFix = path.join(game || '', 'Scam With Your Friends_Data', 'Managed', 'ArabicFix.dll');
  const shippedFix = path.join(fixSource(), 'ArabicFix.dll');
  const hash = file => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(gameFix) || hash(gameFix) !== hash(shippedFix)) throw Error('طبّق التحسينات من الرئيسية مرة واحدة لتجهيز دعم أصوات الشخصيات، ثم أعد الإضافة.');
  const store = characterStore(), p = store.read(id);
  const helper = path.join(game || '', 'Scam With Your Friends_Data', 'ArabicTTS', 'supertts.exe');
  if (!fs.existsSync(helper) || hash(helper) !== hash(helperPath())) throw Error('أعد تطبيق التحسينات من الرئيسية لتحديث محرك الصوت.');
  if (p.voiceMode === 'preset') await previewCharacter(id, game, p.opening, 'preset-reference.wav');
  else {
    const model = path.join(app.getPath('userData'), 'models', 'character-voice', 'Chatterbox-GGUF', 'chatterbox-q8_0.gguf');
    if (!fs.existsSync(model) || fs.statSync(model).size !== 2088399204) throw Error('نزّل نموذج الصوت المخصص أولًا من صفحة الشخصيات.');
    await previewCharacter(id, game, p.opening);
  }
  return { character: store.install(id, game) };
}, true));
function writeGameSave(doc) {
  const file = path.join(gameUserDir(), 'MetaSave', 'local.json');
  fs.writeFileSync(file + '.brave-tmp', JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(file + '.brave-tmp', file);
}
function restoreCharacterTrial() {
  const trial = getTrial(); if (!trial) return;
  const doc = JSON.parse(fs.readFileSync(path.join(gameUserDir(), 'MetaSave', 'local.json'), 'utf8'));
  let current; try { current = JSON.parse(doc.values.DailyCallers); } catch {}
  if (!current || current.callerIds?.length !== 1 || current.callerIds[0] !== trial.id || current.randomCommunityCallers) throw Error('قائمة المكالمات تغيّرت داخل اللعبة؛ عدّلها من «المتصلون اليوميون» حتى لا نستبدل اختياراتك الجديدة.');
  if (trial.hadValue) doc.values.DailyCallers = trial.before;
  else delete doc.values.DailyCallers;
  writeGameSave(doc); fs.unlinkSync(trialFile());
}
ipcMain.handle('character-trial', (_e, id) => characterJob(async () => {
  if (getTrial()) restoreCharacterTrial();
  const store = characterStore(); if (!store.view(id).current) throw Error('أضف آخر تعديل للشخصية إلى اللعبة أولًا.');
  const doc = JSON.parse(fs.readFileSync(path.join(gameUserDir(), 'MetaSave', 'local.json'), 'utf8'));
  const trial = { id, hadValue: Object.hasOwn(doc.values, 'DailyCallers'), before: doc.values.DailyCallers,
    value: JSON.stringify({ enabled: true, randomCommunityCallers: false, randomCommunityOnly: false, defaultsInitialized: true,
      callerIds: [id], day: 0, lastCallerId: null, letPlayersModifyQueue: true }) };
  fs.writeFileSync(trialFile(), JSON.stringify(trial, null, 2), 'utf8');
  doc.values.DailyCallers = trial.value; writeGameSave(doc); return { trial: id };
}, true));
ipcMain.handle('character-trial-restore', () => characterJob(async () => { restoreCharacterTrial(); return { trial: null }; }, true));
ipcMain.handle('character-disable', (_e, id, game) => characterJob(async () => {
  if (getTrial()?.id === id) restoreCharacterTrial();
  return { character: characterStore().disable(id, game) };
}, true));

// ---- microphone test -----------------------------------------------------------
// Microphone tests remain in memory; the same worker stays warm between requests.
function sttHelperCommand() {
  const exe = helperPath();
  if (fs.existsSync(exe)) return { cmd: exe, args: [] };
  const py = path.join(__dirname, 'engine', '.venv', 'Scripts', 'python.exe');
  return { cmd: fs.existsSync(py) ? py : 'python', args: ['-X', 'utf8', path.join(__dirname, 'engine', 'supertts.py')], cwd: path.join(__dirname, 'engine') };
}
const { SttWorker } = require('./stt-worker');
let micWorker = null, micWorkerKey = '', micGameWatch = null;
let micClosing = Promise.resolve();
let micQueue = Promise.resolve(), micEpoch = 0;
function closeMicWorker() {
  if (micGameWatch) clearInterval(micGameWatch);
  micGameWatch = null;
  if (micWorker) { const worker = micWorker; micClosing = micClosing.then(() => worker.close()); }
  micWorker = null; micWorkerKey = '';
  return micClosing;
}
app.on('before-quit', closeMicWorker);
ipcMain.handle('mic-release', async () => { micEpoch++; await closeMicWorker(); return true; });

ipcMain.handle('mic-transcribe', (_e, samples, o = {}) => {
  const epoch = micEpoch;
  const task = micQueue.then(() => epoch === micEpoch ? transcribeMic(samples, o) : { ok: false, error: 'أُلغي الاختبار' });
  micQueue = task.catch(() => {});
  return task;
});
async function transcribeMic(samples, o) {
  if (busy) return { ok: false, error: 'انتظر اكتمال تجهيز الأداة أولًا.' };
  if (await isGameRunning()) return { ok: false, error: 'أغلق اللعبة مؤقتًا قبل اختبار النموذج حتى تتوفر ذاكرة الجهاز للتجربة.' };
  if (!(samples instanceof Uint8Array) && !(samples instanceof ArrayBuffer)) return { ok: false, error: 'تسجيل غير صالح' };
  const pcm = Buffer.from(samples instanceof ArrayBuffer ? samples : samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  if (pcm.length % 4 || pcm.length < 1600 * 4 || pcm.length > 16000 * 60 * 4) return { ok: false, error: 'التسجيل قصير أو طويل جداً' };
  const model = String(o.model || 'small');
  const threads = Math.max(1, Math.min(16, Number(o.threads) || 4));
  const key = JSON.stringify([model, threads]);
  try {
    if (!micWorker || micWorker.dead || key !== micWorkerKey) {
      await closeMicWorker(); micWorkerKey = key;
      micWorker = new SttWorker(sttHelperCommand(), { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        ARABICAI_STT_MODEL: model, ARABICAI_STT_THREADS: String(threads), ARABICAI_STT_DEVICE: 'auto' });
      micGameWatch = setInterval(async () => { if (await isGameRunning()) closeMicWorker(); }, 3000);
      micGameWatch.unref();
    }
    return await micWorker.transcribe(pcm, o.profile === 'baseline' ? 'baseline' : 'improved');
  } catch (e) { closeMicWorker(); return { ok: false, error: 'تعذّر التعرّف. تأكد من تنزيل النموذج عبر تطبيق التحسينات. ' + e.message }; }
}

ipcMain.handle('mic-game-clip', () => {
  try {
    const game = readSettings().gamePath;
    if (!game) throw new Error('اختر مجلد اللعبة أولًا.');
    const dir = path.join(game, GAME_DIR_NAME + '_Data', 'ArabicTTS', 'stt-clips');
    const clips = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^last-[1-5]\.wav$/.test(n)) : [];
    clips.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    if (!clips.length) throw new Error('فعّل «تسجيل تشخيصي داخل اللعبة» وطبّق، ثم جرّب جملة داخل اللعبة.');
    const file = path.join(dir, clips[0]);
    if (fs.statSync(file).size > 16000 * 60 * 2 + 1024) throw new Error('التسجيل أطول من المسموح.');
    const wav = fs.readFileSync(file);
    // Only load the exact PCM format written by our helper, never arbitrary file paths.
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
        wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
        wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' ||
        wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2) throw new Error('صيغة التسجيل غير مدعومة.');
    const samples = new Float32Array((wav.length - 44) / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(44 + i * 2) / 32768;
    return { ok: true, samples: samples.buffer, at: fs.statSync(file).mtime.toISOString() };
  } catch (e) { return { ok: false, error: e.message }; }
});

function speechCommand(flag, timeout = 60000) {
  return new Promise(resolve => {
    const { cmd, args, cwd } = sttHelperCommand();
    const child = spawn(cmd, [...args, flag], { cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '', finished = false;
    const done = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); done({ ok: false, error: 'انتهت مهلة التجهيز. جرّب لاحقًا.' }); }, timeout);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err = (err + d.toString('utf8')).slice(-3000); if (win && !win.isDestroyed()) win.webContents.send('log', d.toString('utf8').trim()); });
    child.on('error', e => done({ ok: false, error: e.message }));
    child.on('close', () => {
      const line = out.split('\n').find(l => l.startsWith('OK '));
      try { done(line ? { ok: true, ...JSON.parse(line.slice(3)) } : { ok: false, error: err.trim().split('\n').pop() || 'تعذّر التجهيز' }); }
      catch { done({ ok: false, error: 'نتيجة غير صالحة' }); }
    });
  });
}
ipcMain.handle('stt-hardware', () => speechCommand('--stt-hardware'));
ipcMain.handle('install-stt-gpu', async () => {
  if (busy) return { ok: false, error: 'انتظر انتهاء العملية الحالية' };
  busy = true; await closeMicWorker();
  try { return await speechCommand('--install-stt-gpu', 40 * 60 * 1000); } finally { busy = false; }
});

ipcMain.handle('apply', async (_e, game, o) => {
  if (busy) return { ok: false, error: 'فيه عملية شغّالة' };
  if (await isGameRunning()) return { ok: false, error: 'اللعبة شغّالة. أغلقها ثم حاول من جديد.' };
  busy = true; await closeMicWorker();
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
    if (o.ttsSteps) args.push('--tts-steps', String(o.ttsSteps));
    if (o.genderVoices === false) args.push('--no-tts-gender');
    if (o.sttModel) args.push('--stt-model', String(o.sttModel));
    if (o.stt) args.push('--stt-silence', String(Math.max(0.7, Math.min(2, Number(o.sttSilence) || 1.25))));
    if (o.sttOld) args.push('--stt-profile', 'baseline');
    if (o.sttDebug) args.push('--stt-debug');
    if (listVoices().length) args.push('--voices-dir', voicesDir());
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
