const $ = (id) => document.getElementById(id);
const DISCORD = 'https://discord.gg/ZCxu8kXkS';

const DEFAULTS = {
  text: true, fix: true, prompts: true, short: true, dialect: 'gulf_saudi',
  tts: true, prebuffer: true, prebufferSeconds: 1, stt: true,
  threads: 8, fastModels: false, autoReapply: false, ttsThreads: 4, sttThreads: 6,
};
const state = { game: null, status: null, opts: { ...DEFAULTS }, saved: {}, rows: [], user: { Menu: {}, Controls: {} }, busy: false };
const MAX_RENDER = 200;

// ── icons ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.ic[data-i]').forEach((el) => el.style.setProperty('--i', `url(vendor/icons/${el.dataset.i}.svg)`));

// ── tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
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
const BOOLS = { optText: 'text', optFix: 'fix', optPrompts: 'prompts', optShort: 'short', optTts: 'tts', optBuffer: 'prebuffer', optStt: 'stt', optFast: 'fastModels', optAuto: 'autoReapply' };
const SELECTS = { dialect: ['dialect', String], bufferSeconds: ['prebufferSeconds', Number], threads: ['threads', Number] };

function optsToDom() {
  for (const [id, k] of Object.entries(BOOLS)) $(id).checked = !!state.opts[k];
  for (const [id, [k]] of Object.entries(SELECTS)) {
    const el = $(id); const v = String(state.opts[k]);
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  }
}
function domToOpts() {
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
  state.status = s;
  $('btnRestore').disabled = !s.patched;
  $('banner').hidden = !s.needs_reapply;
  if (s.needs_reapply) setChip('warn', 'اللعبة تحدّثت: تحتاج إعادة تطبيق');
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
  state.opts.sttThreads = Math.max(3, Math.min(8, Math.round(r.logical / 2)));
  optsToDom(); persist();
  $('analyzeMsg').hidden = false;
  $('analyzeMsg').textContent = `${r.cpu} · ${r.logical} خيط · ${r.ram_gb}GB · ${r.gpu}. ` + rec.reasons.join(' — ');
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
  const r = await window.api.apply(state.game, state.opts);
  $('btnApply').classList.remove('busy'); $('btnApply').disabled = false;
  $('progressFill').style.width = r.ok ? '100%' : '0%';
  setTimeout(() => { $('progress').hidden = true; }, 700);
  if (r.ok) showResult(true, 'تم التطبيق. شغّل اللعبة واختر العربية. أول جملة قد تتأخر شوي لأن المشغّلين يبدأون.');
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

// ── start ───────────────────────────────────────────────────────────────────
(async () => {
  const info = await window.api.appInfo();
  $('versionChip').textContent = 'v' + info.version;
  const saved = await window.api.getSettings();
  state.saved = saved || {};
  state.opts = { ...DEFAULTS, ...(saved.opts || {}) };
  optsToDom();

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
