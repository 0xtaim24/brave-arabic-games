// Only used when the page is opened in a plain browser (design preview). Inside the app, preload.js provides window.api.
if (!window.api) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let logCb = () => {};
  window.api = {
    appInfo: async () => ({ version: '1.0.0', packaged: false }),
    getSettings: async () => ({ tuned: true, gamePath: 'D:\\SteamLibrary\\steamapps\\common\\Scam With Your Friends' }),
    saveSettings: async () => true,
    openExternal: async () => {},
    findGame: async () => 'D:\\SteamLibrary\\steamapps\\common\\Scam With Your Friends',
    browse: async () => null,
    gameRunning: async () => false,
    detect: async () => ({ ok: true }),
    status: async () => ({ ok: true, patched: true, intact: true, needs_reapply: false }),
    analyze: async () => ({ ok: true, cpu: 'Intel Core i5-10400F', logical: 12, ram_gb: 17, gpu: 'GTX 1060', recommend: { threads: 8, fast_models: true, reasons: ['قرص اللعبة بطيء (USB)', 'المعالج 12 خيط'] } }),
    exportRows: async () => ({ ok: true, rows: [
      { table: 'Menu', id: '1', key: 'menu.play', en: 'Play', ar: 'العب' },
      { table: 'Controls', id: '2', key: 'Dance', en: 'Dance', ar: 'ارقص' },
      { table: 'Menu', id: '3', key: 'ui.123', en: 'ADDED TO SCAMAZON', ar: null },
    ] }),
    apply: async () => {
      for (const m of ['Backed up x', 'Patching Arabic text tables…', 'Improving Arabic AI-caller instructions…', 'Tuning Arabic speech recognition…', 'Smoothing Arabic voice', 'Installed Arabic text fix']) { logCb(m); await wait(500); }
      return { ok: true };
    },
    restore: async () => ({ ok: true }),
    getUser: async () => ({ Menu: {}, Controls: {} }),
    saveUser: async () => true,
    installUpdate: async () => {},
    checkUpdate: async () => {},
    onLog: (cb) => { logCb = cb; },
    onUpdate: () => {},
  };
}
