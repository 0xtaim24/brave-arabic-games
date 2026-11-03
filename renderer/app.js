const $ = (id) => document.getElementById(id);
const DISCORD = 'https://discord.gg/ZCxu8kXkS';

const DEFAULTS = {
  text: true, fix: true, prompts: true, short: false, dialect: 'gulf_saudi',
  tts: true, prebuffer: true, prebufferSeconds: 1, stt: true,
  threads: 8, fastModels: false, autoReapply: false, ttsThreads: 4, sttThreads: 4,
  sttModel: 'auto', sttCustom: '', ttsTier: 'auto', genderVoices: true, sttDebug: false, sttOld: false, sttSilence: 1.25,
};
const state = { game: null, status: null, opts: { ...DEFAULTS }, saved: {}, rows: [], user: { Menu: {}, Controls: {} }, busy: false };
const MAX_RENDER = 200;

// ── icons ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.ic[data-i]').forEach((el) => el.style.setProperty('--i', `url(vendor/icons/${el.dataset.i}.svg)`));

// ── tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab !== 'mic') micClose(true);
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === b.dataset.tab));
  $('main').scrollTo({ top: 0 });
}));

// ── helpers ─────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}
const log = (m) => { const el = $('log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; };

function setChip(kind, text) {
  const c = $('gameChip'); c.className = 'chip ' + kind; c.querySelector('span').textContent = text;
}

// ── options <-> DOM ─────────────────────────────────────────────────────────
const BOOLS = { optText: 'text', optFix: 'fix', optPrompts: 'prompts', optShort: 'short', optTts: 'tts', optBuffer: 'prebuffer', optStt: 'stt', optFast: 'fastModels', optAuto: 'autoReapply', optGender: 'genderVoices', optSttDebug: 'sttDebug', optSttOld: 'sttOld' };
const SELECTS = { dialect: ['dialect', String], bufferSeconds: ['prebufferSeconds', Number], threads: ['threads', Number], sttModel: ['sttModel', String], ttsTier: ['ttsTier', String], sttSilence: ['sttSilence', Number] };

function optsToDom() {
  for (const [id, k] of Object.entries(BOOLS)) $(id).checked = !!state.opts[k];
  for (const [id, [k]] of Object.entries(SELECTS)) {
    const el = $(id); const v = String(state.opts[k]);
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  }
}
function domToOpts() {
  state.opts.sttCustom = $('sttCustom').value.trim();
  for (const [id, k] of Object.entries(BOOLS)) state.opts[k] = $(id).checked;
  for (const [id, [k, cast]] of Object.entries(SELECTS)) state.opts[k] = cast($(id).value);
}
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveSettings({ ...state.saved, opts: state.opts, gamePath: state.game }), 250);
}
[...Object.keys(BOOLS), ...Object.keys(SELECTS)].forEach((id) => $(id).addEventListener('change', () => { domToOpts(); persist(); }));

// ── game + status ───────────────────────────────────────────────────────────
async function setGame(dir, silent) {
  if (!dir) return false;
  const r = await window.api.detect(dir);
  $('gamePath').value = dir;
  if (!r.ok) {
    state.game = null;
    setChip('bad', 'هذا مو مجلد اللعبة');
    ['btnApply', 'btnRestore', 'btnAnalyze'].forEach((id) => { $(id).disabled = true; });
    if (!silent) toast('اختر المجلد اللي فيه Scam With Your Friends.exe');
    return false;
  }
  state.game = dir;
  $('btnApply').disabled = false; $('btnAnalyze').disabled = false;
  persist();
  await refreshStatus();
  return true;
}

async function refreshStatus() {
  const s = await window.api.status(state.game);
  const update = braveReapplyState(s, state.game, state.version, state.saved.appliedVersions);
  s.needs_reapply = update.needsReapply;
  state.status = s;
  $('btnRestore').disabled = !s.patched;
  $('banner').hidden = !s.needs_reapply;
  $('reapplyTitle').textContent = update.title;
  $('reapplyReason').textContent = update.reason;
  if (s.needs_reapply) setChip('warn', 'تحتاج إعادة تطبيق التحسينات');
  else if (s.patched) setChip('ok', 'اللعبة جاهزة ومطبّق عليها');
  else setChip('ok', 'تم العثور على اللعبة');
  $('applyLabel').textContent = s.patched ? 'إعادة التطبيق' : 'تطبيق التحسينات';
}

$('btnFind').addEventListener('click', async () => {
  setChip('', 'جاري البحث في Steam…');
  const g = await window.api.findGame();
  if (g) await setGame(g); else { setChip('bad', 'ما لقيت اللعبة'); toast('اختر المجلد يدوياً'); }
});
$('btnBrowse').addEventListener('click', async () => { const d = await window.api.browse(); if (d) await setGame(d); });

// ── auto tune ───────────────────────────────────────────────────────────────
async function autoTune(quiet) {
  if (!state.game) return;
  if (!quiet) { $('analyzeMsg').hidden = false; $('analyzeMsg').textContent = 'جاري تحليل جهازك…'; }
  const r = await window.api.analyze(state.game);
  if (!r.ok) { if (!quiet) $('analyzeMsg').textContent = 'فشل التحليل: ' + r.error; return; }
  const rec = r.recommend;
  state.opts.threads = [6, 8, 10, 12].includes(rec.threads) ? rec.threads : (rec.threads >= 9 ? 10 : (rec.threads >= 7 ? 8 : 6));
  state.opts.fastModels = rec.fast_models;
  state.opts.ttsThreads = Math.max(2, Math.min(6, Math.round(r.logical / 3)));
  state.opts.sttThreads = Math.max(2, Math.min(6, Math.floor(r.logical / 3)));
  optsToDom(); persist();
  $('analyzeMsg').hidden = false;
  $('analyzeMsg').textContent = `${r.cpu} · ${r.logical} خيط · ${r.ram_gb}GB · ${r.gpu}. ` + rec.reasons.join(' — ');
  if (!quiet && (state.opts.sttModel === 'auto' || state.opts.ttsTier === 'auto')) await autoModels();
}
$('btnAnalyze').addEventListener('click', () => autoTune(false));

// ── apply / restore ─────────────────────────────────────────────────────────
const STEPS = [
  ['Backed up', 10, 'أخذ نسخة احتياطية'], ['Game update detected', 10, 'اكتشاف تحديث اللعبة'],
  ['Patching Arabic text', 24, 'ترجمة النصوص'], ['Text patched', 30, 'ترجمة النصوص'],
  ['Improving Arabic AI', 38, 'تحسين ردود المتصلين'], ['Raising Arabic voice', 46, 'ضبط الأداء'],
  ['Tuning Arabic speech', 54, 'تجهيز التعرف على كلامك'], ['Downloading the speech', 64, 'تحميل نموذج التعرف (أول مرة فقط)'],
  ['Speech recognition setting', 68, 'ضبط إعداد التعرف'], ['Smoothing Arabic voice', 74, 'تنعيم الصوت'],
  ['Downloading the Arabic voice', 84, 'تحميل نموذج الصوت (أول مرة فقط)'], ['Copying voice model', 88, 'نقل نموذج الصوت'],
  ['Installed Arabic text fix', 94, 'إصلاح الحروف المعكوسة'], ['Restored', 60, 'استرجاع الملفات'],
];
function onLog(m) {
  log(m);
  if (state.gpuBusy) $('gpuStatus').textContent = 'جاري تجهيز التسريع… قد يستغرق التنزيل عدة دقائق.';
  if (state.autoBusy && $('autoLine')) $('autoLine').textContent = m;
  const hit = STEPS.find(([k]) => m.includes(k));
  if (hit) { $('progressFill').style.width = hit[1] + '%'; $('progressText').textContent = hit[2] + '…'; }
}
window.api.onLog(onLog);

function showResult(ok, msg) {
  const r = $('result'); r.hidden = false; r.className = 'result ' + (ok ? 'ok' : 'bad');
  r.innerHTML = '';
  const i = document.createElement('i'); i.className = 'ic'; i.style.setProperty('--i', `url(vendor/icons/${ok ? 'circle-check' : 'circle-alert'}.svg)`);
  const s = document.createElement('span'); s.textContent = msg;
  r.append(i, s);
}

async function runApply() {
  if (state.busy || !state.game) return;
  state.busy = true;
  domToOpts();
  $('log').textContent = ''; $('result').hidden = true;
  $('progress').hidden = false; $('progressFill').style.width = '4%'; $('progressText').textContent = 'جاري التجهيز…';
  $('btnApply').classList.add('busy'); $('btnApply').disabled = true; $('btnRestore').disabled = true;
  if ((state.opts.sttModel === 'auto' && state.saved.auto?.profile !== 'arabic-local-v2') ||
      (state.opts.ttsTier === 'auto' && !state.saved.auto)) {
    $('progressText').textContent = 'اختيار أفضل نموذج لجهازك…';
    await autoModels();
  }
  const r = await window.api.apply(state.game, { ...state.opts, ...resolveModels() });
  $('btnApply').classList.remove('busy'); $('btnApply').disabled = false;
  $('progressFill').style.width = r.ok ? '100%' : '0%';
  setTimeout(() => { $('progress').hidden = true; }, 700);
  if (r.ok) {
    state.saved.appliedVersions = { ...state.saved.appliedVersions, [state.game.toLowerCase()]: state.version };
    persist();
    let msg = 'تم التطبيق. شغّل اللعبة واختر العربية. أول جملة قد تتأخر شوي لأن المشغّلين يبدأون.';
    if (r.stt_seconds > 4.5) msg += ` تنبيه: التعرف على كلامك بطيء على جهازك (حوالي ${Math.round(r.stt_seconds)} ثواني للجملة). من تبويب «النماذج» اختر Whisper small ثم طبّق من جديد.`;
    showResult(!(r.stt_seconds > 4.5), msg);
  }
  else showResult(false, r.error || 'صار خطأ');
  state.busy = false;
  await refreshStatus();
}
$('btnApply').addEventListener('click', runApply);
$('btnReapply').addEventListener('click', runApply);

$('btnRestore').addEventListener('click', async () => {
  if (state.busy || !confirm('ترجّع ملفات اللعبة الأصلية وتحذف النسخة الاحتياطية؟')) return;
  state.busy = true; $('log').textContent = ''; $('result').hidden = true;
  $('progress').hidden = false; $('progressFill').style.width = '30%'; $('progressText').textContent = 'جاري الاسترجاع…';
  const r = await window.api.restore(state.game);
  $('progress').hidden = true;
  showResult(!!r.ok, r.ok ? 'تم استرجاع الملفات الأصلية.' : (r.error || 'صار خطأ'));
  state.busy = false;
  await refreshStatus();
});

// ── help + updates ──────────────────────────────────────────────────────────
['btnHelp', 'btnHelp2'].forEach((id) => $(id).addEventListener('click', () => window.api.openExternal(DISCORD)));

window.api.onUpdate((u) => {
  const box = $('updateBox'), txt = $('updateText'), bar = $('updateBar'), btn = $('btnUpdate');
  box.hidden = !['available', 'downloading', 'ready'].includes(u.state);
  bar.hidden = u.state !== 'downloading'; btn.hidden = u.state !== 'ready';
  if (u.state === 'available') txt.textContent = `تحديث ${u.version} متوفر…`;
  if (u.state === 'downloading') { txt.textContent = `تحميل التحديث ${u.percent}%`; bar.firstElementChild.style.width = u.percent + '%'; }
  if (u.state === 'ready') txt.textContent = `التحديث ${u.version} جاهز`;
});
$('btnUpdate').addEventListener('click', () => window.api.installUpdate());

// ── strings editor ──────────────────────────────────────────────────────────
const rowKey = (r) => r.key || r.en;
const current = (r) => state.user[r.table]?.[rowKey(r)];

function renderRows() {
  const q = $('search').value.trim().toLowerCase();
  const tf = $('tableFilter').value;
  const miss = $('onlyMissing').checked;
  const list = state.rows.filter((r) =>
    (tf === 'all' || r.table === tf) && (!miss || (!r.ar && current(r) === undefined)) &&
    (!q || r.en.toLowerCase().includes(q) || (r.ar || '').includes(q) || r.key.toLowerCase().includes(q)));
  const box = $('rows'); box.textContent = '';
  if (!list.length) { box.innerHTML = '<div class="empty">لا توجد نتائج</div>'; return; }
  list.slice(0, MAX_RENDER).forEach((r) => {
    const val = current(r);
    const row = document.createElement('div');
    row.className = 'srow' + (!r.ar && val === undefined ? ' missing' : '') + (val !== undefined ? ' edited' : '');
    const en = document.createElement('div'); en.className = 'en'; en.textContent = r.en;
    const ta = document.createElement('textarea');
    ta.value = val !== undefined ? val : (r.ar || '');
    ta.rows = Math.min(4, Math.max(1, Math.ceil(r.en.length / 60)));
    ta.addEventListener('input', () => {
      const v = ta.value;
      state.user[r.table] ||= {};
      if (v.trim() && v !== (r.ar || '')) state.user[r.table][rowKey(r)] = v; else delete state.user[r.table][rowKey(r)];
      row.classList.toggle('edited', state.user[r.table][rowKey(r)] !== undefined);
      $('btnSaveStrings').disabled = false;
    });
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = r.table + ' · ' + (r.key || '');
    row.append(en, ta, meta);
    box.appendChild(row);
  });
  if (list.length > MAX_RENDER) {
    const more = document.createElement('div'); more.className = 'empty';
    more.textContent = `يعرض أول ${MAX_RENDER} من ${list.length}. استخدم البحث لتضييق النتائج.`;
    box.appendChild(more);
  }
}

$('btnLoad').addEventListener('click', async () => {
  if (!state.game) { $('stringsMsg').textContent = 'حدد مجلد اللعبة من الرئيسية أولاً.'; return; }
  $('stringsMsg').textContent = 'جاري تحميل النصوص…';
  const [r, u] = await Promise.all([window.api.exportRows(state.game), window.api.getUser()]);
  if (!r.ok) { $('stringsMsg').textContent = 'فشل: ' + r.error; return; }
  state.rows = r.rows; state.user = { Menu: {}, Controls: {}, ...u };
  $('stringsMsg').textContent = `${r.rows.length} نص. الناقص بالأصل: ${r.rows.filter((x) => !x.ar).length}. عدّل ثم احفظ، وبعدها طبّق من الرئيسية.`;
  renderRows();
});
$('btnSaveStrings').addEventListener('click', async () => {
  await window.api.saveUser(state.user);
  $('btnSaveStrings').disabled = true;
  toast('تم حفظ تعديلاتك. طبّق التحسينات من الرئيسية.');
});
let searchTimer; $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderRows, 150); });
$('tableFilter').addEventListener('change', renderRows);
$('onlyMissing').addEventListener('change', renderRows);


// ── models (speech recognition + voice quality) ─────────────────────────────
state.models = { stt: [], tts: [] };

function renderModelOptions() {
  const s = $('sttModel'); s.innerHTML = '';
  s.append(new Option('تلقائي (حسب جهازي)', 'auto'));
  state.models.stt.forEach((m) => s.append(new Option(`${m.name} · ${m.size_mb}MB${m.installed ? ' · مثبّت' : ''}`, m.id)));
  s.append(new Option('مخصّص…', 'custom'));
  const micSelect = $('micModel'), previous = micSelect.value;
  micSelect.innerHTML = '';
  micSelect.append(new Option('النموذج المختار للأداة', 'selected'));
  state.models.stt.filter(m => m.installed).forEach(m => micSelect.append(new Option(m.name, m.id)));
  if ([...micSelect.options].some(o => o.value === previous)) micSelect.value = previous;
  const t = $('ttsTier'); t.innerHTML = '';
  t.append(new Option('تلقائي (حسب جهازي)', 'auto'));
  state.models.tts.forEach((x) => t.append(new Option(x.name, x.id)));
  optsToDom();
  $('sttCustom').value = state.opts.sttCustom || '';
  describeStt();
}
function describeStt() {
  const v = $('sttModel').value;
  $('sttCustomRow').hidden = v !== 'custom';
  const m = state.models.stt.find((x) => x.id === v);
  const auto = state.saved.auto;
  $('sttDesc').textContent = v === 'auto'
    ? (auto ? `المختار لجهازك: ${auto.stt} (جودة الصوت ${auto.tts_steps} خطوة).` : 'يبدأ بـCohere العربي المتوازن، ويقيس الاستجابة على جهازك. يجرب خيارًا أخف عند الحاجة. التنزيل أول مرة نحو 1.8 جيجابايت؛ اختبر الدقة بصوتك أيضًا.')
    : v === 'custom' ? 'أي نموذج بصيغة faster-whisper (CTranslate2) من Hugging Face أو من مجلد عندك.'
    : m ? `${m.desc}. حجمه ${m.size_mb} ميجا.` : '';
}
$('sttModel').addEventListener('change', describeStt);
$('sttCustom').addEventListener('input', () => { domToOpts(); persist(); });

async function loadModels() {
  const r = await window.api.models();
  if (r && r.ok) { state.models = r; renderModelOptions(); }
}

function resolveModels() {
  const auto = state.saved.auto || {};
  let stt = state.opts.sttModel;
  if (stt === 'auto') stt = auto.stt || 'small';
  if (stt === 'custom') stt = (state.opts.sttCustom || '').replace(/^hf:/, '') || 'small';
  const tier = state.opts.ttsTier;
  const steps = tier === 'auto' ? (auto.tts_steps || 8) : ((state.models.tts.find((x) => x.id === tier) || {}).steps || 8);
  return { sttModel: stt, ttsSteps: steps };
}

async function autoModels() {
  const card = $('autoCard');
  state.autoBusy = true;
  card.hidden = false;
  card.innerHTML = '<b>جاري الاختبار…</b><small id="autoLine">يختبر سرعة جهازك وينزّل النموذج المناسب (قد ياخذ دقائق أول مرة).</small>';
  $('btnAutoModels').disabled = true;
  const r = await window.api.modelsAuto();
  state.autoBusy = false;
  $('btnAutoModels').disabled = false;
  if (!r || !r.ok) {
    card.replaceChildren();
    const title = document.createElement('b'); title.textContent = 'ما قدرت أختار تلقائياً';
    const detail = document.createElement('small'); detail.textContent = r?.error || 'تأكد من الإنترنت وجرّب من جديد';
    card.append(title, detail); return;
  }
  state.saved.auto = { stt: r.stt, tts_steps: r.tts_steps, tts_tier: r.tts_tier, bench: r.bench, profile: r.profile, at: Date.now() };
  persist();
  const b = r.bench[r.stt];
  const tier = state.models.tts.find((x) => x.id === r.tts_tier);
  card.innerHTML = '';
  const chosenName = state.models.stt.find(x => x.id === r.stt)?.name || r.stt;
  const t1 = document.createElement('b'); t1.textContent = `اخترت لجهازك: ${chosenName} + صوت ${tier ? tier.name : r.tts_steps + ' خطوة'}`;
  const t2 = document.createElement('small');
  t2.textContent = (b ? `التعرف: ${b.seconds} ثانية لكلام ${b.audio_s} ثانية (خطأ حروف ${Math.round(b.cer * 100)}% على عينة صناعية، وليس قياسًا لدقة صوتك). ` : '') +
    `الصوت: يتولّد ${Math.round(1 / Math.max(0.01, r.bench.tts.rtf * r.tts_steps / 8))} أضعاف سرعة الكلام.`;
  card.append(t1, t2);
  describeStt();
  toast('تم اختيار النماذج. اضغط «تطبيق التحسينات» لتثبيتها.');
}
$('btnAutoModels').addEventListener('click', autoModels);

// custom voices
function renderVoices(list) {
  const box = $('voiceList'); box.textContent = '';
  if (!Array.isArray(list) || !list.length) { box.innerHTML = '<span class="note">ما أضفت أصوات بعد.</span>'; return; }
  list.forEach((name) => {
    const chip = document.createElement('span'); chip.className = 'voice-chip';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = /^f/i.test(name) ? 'نسائي' : /^m/i.test(name) ? 'رجالي' : 'عام';
    const lab = document.createElement('span'); lab.textContent = name; lab.dir = 'ltr';
    const rm = document.createElement('button'); rm.title = 'حذف'; rm.innerHTML = '<i class="ic ic-s" data-i="x"></i>';
    rm.firstChild.style.setProperty('--i', 'url(vendor/icons/x.svg)');
    rm.addEventListener('click', async () => renderVoices(await window.api.removeVoice(name)));
    chip.append(tag, lab, rm); box.append(chip);
  });
}
$('btnAddVoice').addEventListener('click', async () => {
  const r = await window.api.addVoice();
  if (r && r.error) toast(r.error); else renderVoices(r);
});

// ── microphone test ─────────────────────────────────────────────────────────
// Captures raw audio (no browser echo-cancel / noise-suppress / auto-gain, so the level is the real one), keeps the
// clip in memory only, and sends 16 kHz mono samples to the recogniser on demand.
const mic = { stream: null, ctx: null, node: null, chunks: [], recording: false, clip: null, url: null, peak: 0, holdUntil: 0, started: 0 };
const dbOf = (v) => (v > 1e-5 ? 20 * Math.log10(v) : -100);
const fmtDb = (v) => '⁦' + (v <= -99 ? '−∞' : v.toFixed(0)) + ' dB⁩';   // isolated so the minus sign stays on the number in RTL text

async function fillDevices(selectedId) {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const sel = $('micDevice'); sel.innerHTML = '';
  list.forEach((d) => sel.append(new Option(d.label || 'ميكروفون', d.deviceId)));
  if (selectedId && list.some((d) => d.deviceId === selectedId)) sel.value = selectedId;
}

async function micOpen() {
  micClose();
  const deviceId = $('micDevice').value;
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    $('micInfo').textContent = 'ما قدرت أفتح الميكروفون: تأكد من إذن الميكروفون في ويندوز (الخصوصية ← الميكروفون).';
    return false;
  }
  await fillDevices(mic.stream.getAudioTracks()[0].getSettings().deviceId);
  const st = mic.stream.getAudioTracks()[0].getSettings();
  mic.ctx = new AudioContext();
  const src = mic.ctx.createMediaStreamSource(mic.stream);
  mic.node = mic.ctx.createScriptProcessor(2048, 1, 1);
  mic.node.onaudioprocess = (ev) => {
    const x = ev.inputBuffer.getChannelData(0);
    let s = 0, pk = 0;
    for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; const a = Math.abs(x[i]); if (a > pk) pk = a; }
    const rms = Math.sqrt(s / x.length), now = performance.now();
    if (mic.recording) mic.chunks.push({ data: new Float32Array(x), rms });
    if (pk >= mic.peak || now > mic.holdUntil) { mic.peak = pk; mic.holdUntil = now + 900; }
    const db = dbOf(rms);
    $('micBar').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    $('micPeakMark').style.insetInlineStart = Math.max(0, Math.min(100, (dbOf(mic.peak) + 60) / 60 * 100)) + '%';
    $('micDb').textContent = fmtDb(db);
  };
  const mute = mic.ctx.createGain(); mute.gain.value = 0;          // the processor only runs when connected to the output; muted = no feedback
  src.connect(mic.node); mic.node.connect(mute); mute.connect(mic.ctx.destination);
  $('micInfo').textContent = `${mic.stream.getAudioTracks()[0].label || 'ميكروفون'} · ${Math.round(mic.ctx.sampleRate / 1000 * 10) / 10} kHz · ${st.channelCount || 1} قناة`;
  $('btnMicRec').disabled = false;
  $('btnMicStart').querySelector('span').textContent = 'إيقاف الاختبار';
  return true;
}
function micClose(cancelRecording = false) {
  if (mic.recording && cancelRecording) {
    clearTimeout(mic.autoStop); mic.recording = false; mic.chunks = [];
    document.body.classList.remove('recording');
    $('btnMicRec').hidden = false; $('btnMicStop').hidden = true;
  } else if (mic.recording) micStopRec();
  if (mic.node) { try { mic.node.disconnect(); } catch { /* closed */ } mic.node.onaudioprocess = null; }
  if (mic.ctx) mic.ctx.close().catch(() => {});
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  mic.stream = mic.ctx = mic.node = null;
  $('micBar').style.width = '0'; $('micDb').textContent = '— dB';
  $('btnMicRec').disabled = true;
  $('btnMicStart').querySelector('span').textContent = 'ابدأ الاختبار';
  if (window.api.releaseMic) window.api.releaseMic();
}

function micStartRec() {
  clearClip();
  mic.chunks = []; mic.recording = true; mic.started = performance.now();
  document.body.classList.add('recording');
  $('btnMicRec').hidden = true; $('btnMicStop').hidden = false;
  $('micHint').textContent = 'جاري التسجيل… قل جملتك ثم اضغط إيقاف (حد أقصى 12 ثانية).';
  mic.autoStop = setTimeout(micStopRec, 12000);
}
async function micStopRec() {
  if (!mic.recording) return;
  clearTimeout(mic.autoStop);
  mic.recording = false;
  document.body.classList.remove('recording');
  $('btnMicRec').hidden = false; $('btnMicStop').hidden = true;
  const rate = mic.ctx ? mic.ctx.sampleRate : 48000;
  const total = mic.chunks.reduce((n, c) => n + c.data.length, 0);
  if (total < rate * 0.3) { $('micHint').textContent = 'التسجيل قصير جداً، جرّب من جديد.'; return; }
  const raw = new Float32Array(total); let o = 0;
  mic.chunks.forEach((c) => { raw.set(c.data, o); o += c.data.length; });
  const frameRms = mic.chunks.map((c) => c.rms);
  mic.chunks = [];
  // exact 16 kHz mono via the browser's resampler (the same rate the game feeds its recogniser)
  const off = new OfflineAudioContext(1, Math.ceil(raw.length * 16000 / rate), 16000);
  const buf = off.createBuffer(1, raw.length, rate); buf.copyToChannel(raw, 0);
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  const out = (await off.startRendering()).getChannelData(0);
  mic.clip = { samples: new Float32Array(out), stats: clipStats(out, frameRms, raw.length / rate) };
  $('btnMicPlay').disabled = false; $('btnMicAgain').disabled = false;
  $('micHint').textContent = 'تم التسجيل. جاري التعرّف…';
  recognise();
}
function clipStats(x, frameRms, seconds) {
  let pk = 0, clip = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; if (a > 0.98) clip++; }
  const sorted = [...frameRms].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  return { peak: pk, peakDb: dbOf(pk), speechDb: dbOf(loud), noiseDb: dbOf(noise), clipPct: 100 * clip / x.length, seconds };
}

async function recognise() {
  if (!mic.clip) return;
  const requestId = mic.requestId = (mic.requestId || 0) + 1;
  $('btnMicAgain').disabled = true;
  $('micEmpty').hidden = true; $('micResult').hidden = false;
  $('rText').textContent = '… جاري التعرّف (أول مرة قد يتحمّل النموذج)'; $('rTime').textContent = '—'; $('rVerdict').textContent = ''; $('rVerdict').className = 'verdict';
  const st = mic.clip.stats;
  $('rLevel').textContent = `ذروة ${fmtDb(st.peakDb)} · كلام ${fmtDb(st.speechDb)} · ضوضاء ${fmtDb(st.noiseDb)}`;
  const m = resolveModels();
  const testModel = $('micModel').value;
  const r = await window.api.micTranscribe(mic.clip.samples.buffer.slice(0), { model: testModel === 'selected' ? m.sttModel : testModel, threads: state.opts.sttThreads, profile: $('micProfile').value });
  if (requestId !== mic.requestId) return;
  $('btnMicAgain').disabled = false;
  $('btnMicRec').disabled = !mic.stream;
  if (!r || !r.ok) { $('rText').textContent = '—'; $('rVerdict').textContent = (r && r.error) || 'فشل التعرّف'; $('rVerdict').className = 'verdict bad'; $('micHint').textContent = ''; return; }
  $('rText').textContent = r.text || '(ما فهمت كلام)';
  $('rTime').textContent = `${((r.ms || 0) / 1000).toFixed(2)} ثانية لتسجيل ${st.seconds.toFixed(1)} ثانية` + (r.load_s > 2 ? ` (+ ${r.load_s} ث لتحميل النموذج)` : '');
  $('rModel').textContent = r.model + ` · ${r.device_name || (r.device === 'cuda' ? 'NVIDIA' : 'CPU')}` + (r.fallback && r.fallback.length ? ' (تم استخدام بديل متاح)' : '');
  $('rConf').textContent = r.text && Number.isFinite(r.conf) ? Math.round(r.conf * 100) + '%' : 'غير متاح لهذا النموذج';
  mic.lastText = r.text || ''; compareMicText();
  const v = verdict(st, r);
  $('rVerdict').textContent = v.text; $('rVerdict').className = 'verdict ' + v.kind;
  $('micHint').textContent = 'بدّل «نموذج التجربة» واضغط «أعد التعرّف» لمقارنة نفس التسجيل.';
}
function verdict(st, r) {
  if (st.peak < 0.02) return { kind: 'bad', text: 'التسجيل ضعيف جداً: المشكلة من الميكروفون قبل التعرّف. ارفع مستوى الإدخال في ويندوز (الصوت ← الإدخال) أو قرّب الميكروفون.' };
  if (st.clipPct > 0.3) return { kind: 'bad', text: 'الصوت مقصوص (مرتفع جداً) فتتشوّه الحروف. خفّض مستوى الميكروفون في ويندوز.' };
  if (st.speechDb - st.noiseDb < 12) return { kind: 'warn', text: 'الضوضاء قريبة من صوتك. جرّب مكان أهدى أو قرّب الميكروفون، وشغّل «عزل الضوضاء» في ويندوز إن توفر.' };
  if (st.peak < 0.08) return { kind: 'warn', text: 'الصوت منخفض شوي. الأداة تعوّض، لكن رفع مستوى الميكروفون يحسّن الدقة.' };
  if (!r.text) return { kind: 'warn', text: 'التسجيل واضح لكن ما طلع كلام: إما ما كان فيه كلام مسموع أو النموذج ما التقطه. جرّب نموذج أكبر من تبويب النماذج.' };
  if (Number.isFinite(r.conf) && r.conf < 0.5) return { kind: 'warn', text: 'النموذج غير متأكد من بعض الكلمات. قارن النص بما قلته، ثم جرّب نموذجًا آخر على التسجيل نفسه.' };
  return { kind: '', text: 'مستوى الصوت مناسب. هذا لا يثبت صحة الكلمات؛ قارنها بما قلته واستمع للتسجيل للتأكد من اكتمال الجملة.' };
}

function clearClip() {
  mic.requestId = (mic.requestId || 0) + 1;
  mic.lastText = '';
  if (mic.url) { URL.revokeObjectURL(mic.url); mic.url = null; }
  mic.clip = null;
  $('btnMicPlay').disabled = true; $('btnMicAgain').disabled = true;
}
function playClip() {
  if (!mic.clip) return;
  const x = mic.clip.samples, pcm = new DataView(new ArrayBuffer(44 + x.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => pcm.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); pcm.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
  pcm.setUint32(24, 16000, true); pcm.setUint32(28, 32000, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true); w(36, 'data'); pcm.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) pcm.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  if (mic.url) URL.revokeObjectURL(mic.url);
  mic.url = URL.createObjectURL(new Blob([pcm], { type: 'audio/wav' }));
  new Audio(mic.url).play();
}

$('btnMicStart').addEventListener('click', () => (mic.stream ? micClose() : micOpen()));
$('btnMicRec').addEventListener('click', micStartRec);
$('btnMicStop').addEventListener('click', micStopRec);
$('btnMicPlay').addEventListener('click', playClip);
$('btnMicGameClip').addEventListener('click', async () => {
  const r = await window.api.micGameClip();
  if (!r || !r.ok) { toast(r?.error || 'تعذر تحميل التسجيل'); return; }
  micClose(); clearClip();
  const x = new Float32Array(r.samples), frameRms = [];
  for (let i = 0; i < x.length; i += 512) {
    const part = x.subarray(i, i + 512);
    frameRms.push(Math.sqrt(part.reduce((s, v) => s + v * v, 0) / part.length));
  }
  mic.clip = { samples: x, stats: clipStats(x, frameRms, x.length / 16000) };
  $('btnMicPlay').disabled = false;
  $('micHint').textContent = 'تسجيل اللعبة: ' + new Date(r.at).toLocaleString('ar');
  await recognise();
});
$('btnMicAgain').addEventListener('click', recognise);
$('micDevice').addEventListener('change', () => { if (mic.stream) micOpen(); });
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab !== 'mic' && mic.stream) micClose(); }));

// ── start ───────────────────────────────────────────────────────────────────
(async () => {
  const info = await window.api.appInfo();
  state.version = info.version;
  $('versionChip').textContent = 'v' + info.version;
  const saved = await window.api.getSettings();
  state.saved = saved || {};
  state.opts = { ...DEFAULTS, ...(saved.opts || {}) };
  optsToDom();
  loadModels();
  window.api.listVoices().then(renderVoices);

  let ok = saved.gamePath ? await setGame(saved.gamePath, true) : false;
  if (!ok) {
    const g = await window.api.findGame();
    ok = g ? await setGame(g, true) : false;
  }
  if (!ok) { setChip('bad', 'ما لقيت اللعبة: اختر المجلد'); return; }

  if (!state.saved.tuned) {            // first run: pick settings for this PC automatically
    await autoTune(true);
    state.saved.tuned = true; persist();
    toast('ضبطت الإعدادات حسب جهازك. اضغط «تطبيق التحسينات».');
  }
  if (state.status && state.status.needs_reapply && state.opts.autoReapply) {
    if (await window.api.gameRunning()) toast('اللعبة شغّالة: أغلقها وراح أعيد التطبيق.');
    else runApply();
  }
})();

// The displayed probability is not a calibrated correctness score. Ground truth comes from the user.
function compareMicText() {
  const norm = s => s.normalize('NFKC').replace(/[ً-ٰـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const ref = norm($('micExpected').value), hyp = norm(mic.lastText || '');
  if (!ref.length || !mic.lastText) { $('micComparison').textContent = ''; return; }
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  ref.forEach((word, i) => { const row = [i + 1]; hyp.forEach((w, j) => row.push(Math.min(row[j] + 1, prev[j + 1] + 1, prev[j] + (w === word ? 0 : 1)))); prev = row; });
  const errors = prev[hyp.length];
  $('micComparison').textContent = errors ? `اختلافات كلمات: ${errors} بالنسبة إلى ${ref.length} كلمة مرجعية. هذا قياس لهذه العينة فقط.` : 'الكلمات مطابقة بعد توحيد الكتابة العربية.';
}
$('micExpected').addEventListener('input', compareMicText);
$('btnGpuSetup').addEventListener('click', async () => {
  if (state.gpuBusy || state.busy || state.autoBusy) return;
  state.gpuBusy = true; $('btnGpuSetup').disabled = true;
  $('gpuStatus').textContent = 'جاري تجهيز التسريع (تنزيل مرة واحدة)…';
  try {
    const r = await window.api.installSttGpu();
    $('gpuStatus').textContent = r.ok ? 'مكونات التسريع جاهزة. اختبر الميكروفون؛ ستظهر NVIDIA عند نجاح التشغيل. أعد تطبيق التحسينات للعبة.' : 'تعذّر تجهيز التسريع: ' + (r.error || 'حاول لاحقًا');
  } finally { state.gpuBusy = false; $('btnGpuSetup').disabled = false; }
});
if (window.api.sttHardware) window.api.sttHardware().then(r => {
  if (state.gpuBusy || !r.ok) return;
  if (!r.cuda_devices) { $('gpuStatus').textContent = 'هذا التنزيل خاص بتسريع Whisper على NVIDIA. Cohere يختبر الكرت المتوافق تلقائيًا، ويستخدم المعالج عند الحاجة.'; $('btnGpuSetup').disabled = true; }
  else if (r.runtime_installed) $('gpuStatus').textContent = 'تسريع Whisper جاهز. Cohere يستخدم التسريع المضمّن؛ اختبار الميكروفون يوضح الجهاز المستخدم.';
}).catch(() => {});
