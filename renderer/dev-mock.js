// Only used when the page is opened in a plain browser (design preview). Inside the app, preload.js provides window.api.
if (!window.api) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let logCb = () => {};
  let patched = !location.hash.includes('unpatched');
  window.api = {
    charactersList: async () => ({ ok: true, characters: [], trial: null }),
    characterNew: async () => ({ ok: true, id: 'brave-' + 'a'.repeat(32) }),
    sttHardware: async () => ({ ok: true, cuda_devices: 1, runtime_installed: false }),
    installSttGpu: async () => ({ ok: true, installed: true }),
    appInfo: async () => ({ version: '1.0.1', packaged: false }),
    getSettings: async () => ({ tuned: true, gamePath: 'D:\\SteamLibrary\\steamapps\\common\\Scam With Your Friends' }),
    saveSettings: async () => true,
    openExternal: async () => {},
    findGame: async () => 'D:\\SteamLibrary\\steamapps\\common\\Scam With Your Friends',
    browse: async () => null,
    gameRunning: async () => false,
    detect: async () => ({ ok: true }),
    status: async () => ({ ok: true, patched, intact: patched, needs_reapply: location.hash.includes('update') }),
    analyze: async () => ({ ok: true, cpu: 'Intel Core i5-10400F', logical: 12, ram_gb: 17, gpu: 'GTX 1060', recommend: { threads: 8, fast_models: true, reasons: ['قرص اللعبة بطيء (USB)', 'المعالج 12 خيط'] } }),
    exportRows: async () => ({ ok: true, rows: [
      { table: 'Menu', id: '1', key: 'menu.play', en: 'Play', ar: 'العب' },
      { table: 'Menu', id: '4', key: 'menu.settings', en: 'Settings', ar: 'الإعدادات' },
      { table: 'Controls', id: '2', key: 'Dance', en: 'Dance', ar: 'ارقص' },
      { table: 'Controls', id: '5', key: 'Hold To Speak', en: 'Hold To Speak', ar: 'استمر بالضغط للتحدث' },
      { table: 'Menu', id: '6', key: 'ui.a1', en: 'Caller Trust', ar: 'ثقة المتصل' },
      { table: 'Menu', id: '3', key: 'ui.123', en: 'ADDED TO SCAMAZON', ar: null },
    ] }),
    apply: async () => {
      for (const m of ['Backed up x', 'Patching Arabic text tables…', 'Improving Arabic AI-caller instructions…', 'Tuning Arabic speech recognition…', 'Smoothing Arabic voice', 'Installed Arabic text fix']) { logCb(m); await wait(500); }
      patched = true;
      return { ok: true };
    },
    restore: async () => ({ ok: true }),
    models: async () => ({ ok: true, tts: [{ id: 'fast', steps: 5, name: 'سريع' }, { id: 'balanced', steps: 8, name: 'متوازن (الافتراضي)' }, { id: 'high', steps: 12, name: 'عالي' }, { id: 'ultra', steps: 16, name: 'أعلى جودة' }],
      stt: [{ id: 'tiny', name: 'Whisper tiny', size_mb: 75, desc: 'الأسرع، دقته أقل', installed: true }, { id: 'base', name: 'Whisper base', size_mb: 145, desc: 'سريع ودقته مقبولة', installed: true }, { id: 'small', name: 'Whisper small', size_mb: 480, desc: 'متوازن (الافتراضي)', installed: true }, { id: 'medium', name: 'Whisper medium', size_mb: 1500, desc: 'أدق، يحتاج معالج قوي', installed: false }, { id: 'large-v3-turbo', name: 'Whisper large-v3-turbo', size_mb: 810, desc: 'الأدق، يحتاج معالج قوي جداً', installed: false }] }),
    modelsAuto: async () => { logCb('Testing the Arabic voice speed…'); await wait(500); logCb('Testing speech recognition model small…'); await wait(600); return { ok: true, stt: 'small', tts_steps: 12, tts_tier: 'high', bench: { tts: { rtf: 0.26 }, small: { seconds: 2.7, audio_s: 9.8, cer: 0 } } }; },
    listVoices: async () => ['F_layla', 'M_omar'],
    addVoice: async () => ['F_layla', 'M_omar'],
    removeVoice: async () => ['F_layla'],
    micTranscribe: async () => { await wait(900); return { ok: true, text: 'شو تبي مني الحين؟ ما سويت شي', conf: 0.82, ms: 1240, model: 'small', load_s: 0.4, speech: true, fallback: [] }; },
    getUser: async () => ({ Menu: {}, Controls: {} }),
    saveUser: async () => true,
    installUpdate: async () => {},
    checkUpdate: async () => {},
    onLog: (cb) => { logCb = cb; },
    onUpdate: () => {},
  };
}
