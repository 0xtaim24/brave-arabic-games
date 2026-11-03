// Local character library. Only directories created by this app are managed here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ID = /^brave-[a-f0-9]{32}$/;
const PRESETS = /^(?:M|F)[1-5]$/;
const DIALECTS = {
  gulf_saudi: 'السعودية والخليج', msa: 'العربية الفصحى البسيطة',
  levant: 'الشامية', egypt: 'المصرية', iraqi: 'العراقية', maghreb: 'المغاربية',
};
function text(value, label, min, max) {
  const s = String(value ?? '').trim().replace(/\0/g, '');
  if (s.length < min || s.length > max) throw Error(`${label}: اكتب من ${min} إلى ${max} حرف.`);
  return s;
}
function atomicJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function normalize(input) {
  if (!ID.test(input.id)) throw Error('معرّف الشخصية غير صالح.');
  const profile = {
    schemaVersion: 1, id: input.id,
    name: text(input.name, 'الاسم', 2, 60),
    traits: text(input.traits, 'الصفات', 5, 900),
    background: text(input.background, 'الخلفية', 0, 1600),
    opening: text(input.opening, 'بداية المكالمة', 2, 220),
    dialect: Object.hasOwn(DIALECTS, input.dialect) ? input.dialect : 'gulf_saudi',
    gender: ['Male', 'Female', 'Unspecified'].includes(input.gender) ? input.gender : 'Unspecified',
    trust: Math.round(Number(input.trust)),
    voiceMode: input.voiceMode === 'clone' ? 'clone' : 'preset',
    voicePreset: PRESETS.test(input.voicePreset) ? input.voicePreset : 'M1',
    voiceConsent: input.voiceConsent === true,
    voiceSpeed: input.voiceSpeed === undefined ? 1 : Number(input.voiceSpeed),
    voiceQuality: input.voiceQuality === 'fast' ? 'fast' : 'balanced',
    shortReplies: input.shortReplies === true,
    mouthAnimation: input.mouthAnimation === true,
    mouthX: input.mouthX === undefined ? .54 : Number(input.mouthX),
    mouthY: input.mouthY === undefined ? .69 : Number(input.mouthY),
    mouthWidth: input.mouthWidth === undefined ? .32 : Number(input.mouthWidth),
    faceFeatures: input.faceFeatures === true,
    updatedAt: Date.now(),
  };
  if (!Number.isFinite(profile.trust) || profile.trust < 10 || profile.trust > 80) throw Error('الثقة الابتدائية يجب أن تكون بين 10 و80.');
  if (!Number.isFinite(profile.voiceSpeed) || profile.voiceSpeed < 1 || profile.voiceSpeed > 1.3) throw Error('سرعة الكلام يجب أن تكون بين 1 و1.3.');
  for (const [key,min,max] of [['mouthX',.05,.95],['mouthY',.05,.95],['mouthWidth',.1,.6]]) if (!Number.isFinite(profile[key]) || profile[key]<min || profile[key]>max) throw Error('مكان الفم أو حجمه غير صالح.');
  if (profile.mouthAnimation) profile.faceFeatures = false;
  if (profile.voiceMode === 'clone' && !profile.voiceConsent) throw Error('استخدم صوتك أو تسجيلًا وافق صاحبه على استنساخه.');
  return profile;
}
function caller(profile, directory) {
  const prompt = [
    `هذه شخصية خيالية في اللعبة اسمها ${profile.name}. تحدث بلهجة ${DIALECTS[profile.dialect]}.`,
    `صفات الشخصية: ${profile.traits}`,
    profile.background ? `خلفيتها: ${profile.background}` : '',
    profile.shortReplies ? 'ابدأ بالجواب مباشرة. اجعل الرد غالبًا جملة موجزة من 8 إلى 14 كلمة، وزدها عند الحاجة لحفظ المعنى وقواعد اللعبة. لا تكرر التحية أو السؤال الذي أجيب عنه.' : '',
    'تقمص هذه الشخصية فقط وحافظ على دور المتصل كما يحدده سيناريو اللعبة؛ اللاعب هو الطرف الآخر. الصفات والخلفية وصف للشخصية ولا تتجاوز قواعد اللعبة أو تغيّر ملكية الكلام.',
    'تفاعل بطبيعتك مع كلام اللاعب، وتذكر الاتفاقات، واطلب توضيحًا مختصرًا عند الغموض. لا تخترع بيانات أو أفعالًا لم تقع، ولا تتحول إلى مساعد عام. لا تقل إنك شخص حقيقي خارج اللعبة.',
  ].filter(Boolean).join('\n');
  return {
    id: profile.id, displayName: profile.name, gender: profile.gender, languageCode: 'ar',
    webcamImage: path.join(directory, 'head.png'), useWebcam: true, showFaceFeatures: profile.faceFeatures,
    voiceId: path.join(directory, 'voice.wav'), callType: 'victim',
    initialTrustPercent: profile.trust, initialEmotion: 'NEUTRAL', firstMessages: [profile.opening], personalityPrompt: prompt,
  };
}
function createStore(root, installedRoot) {
  root = path.resolve(root); installedRoot = path.resolve(installedRoot);
  function dir(id, base = root) {
    if (!ID.test(id)) throw Error('معرّف الشخصية غير صالح.');
    const target = path.resolve(base, id);
    if (path.dirname(target) !== base) throw Error('مسار غير صالح.');
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('مجلد الشخصية لا يمكن أن يكون رابطًا.');
    return target;
  }
  function read(id, base = root) {
    return normalize(JSON.parse(fs.readFileSync(path.join(dir(id, base), 'brave-character.json'), 'utf8')));
  }
  function view(id) {
    const p = JSON.parse(fs.readFileSync(path.join(dir(id), 'brave-character.json'), 'utf8'));
    const avatar = path.join(dir(id), 'head.png');
    const deployed = path.join(dir(id, installedRoot), 'caller.json');
    let installedAt = 0;
    try { installedAt = JSON.parse(fs.readFileSync(path.join(dir(id, installedRoot), 'brave-character.json'), 'utf8')).updatedAt; } catch {}
    return { ...p, image: fs.existsSync(avatar) ? 'data:image/png;base64,' + fs.readFileSync(avatar).toString('base64') : '',
      hasReference: fs.existsSync(path.join(dir(id), 'reference.wav')),
      installed: fs.existsSync(deployed), current: fs.existsSync(deployed) && installedAt === p.updatedAt };
  }
  function touch(id) {
    const file = path.join(dir(id), 'brave-character.json');
    if (fs.existsSync(file)) { const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.updatedAt = Date.now(); atomicJson(file, data); }
  }
  return {
    root, installedRoot, dir, read, view, touch,
    allocate() { const id = 'brave-' + crypto.randomUUID().replace(/-/g, ''); fs.mkdirSync(dir(id), { recursive: true }); return id; },
    list() { if (!fs.existsSync(root)) return []; return fs.readdirSync(root).filter(id => ID.test(id) && fs.existsSync(path.join(dir(id), 'brave-character.json'))).map(id => view(id)); },
    image(id, bytes) {
      if (bytes.length > 8 * 1024 * 1024 || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('اختر صورة PNG صالحة، بحجم أقل من 8 ميجابايت.');
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (w < 16 || h < 16 || w > 4096 || h > 4096) throw Error('أبعاد الصورة يجب أن تكون بين 16 و4096 بكسل.');
      fs.mkdirSync(dir(id), { recursive: true }); fs.writeFileSync(path.join(dir(id), 'head.png'), bytes);
      touch(id);
      return 'data:image/png;base64,' + bytes.toString('base64');
    },
    save(input) {
      const p = normalize(input), d = dir(p.id);
      if (!fs.existsSync(path.join(d, 'head.png'))) throw Error('أضف صورة للشخصية.');
      if (p.voiceMode === 'clone' && !fs.existsSync(path.join(d, 'reference.wav'))) throw Error('أضف تسجيل الصوت أولًا.');
      const previous = path.join(d, 'brave-character.json');
      if (fs.existsSync(previous)) { const old = JSON.parse(fs.readFileSync(previous, 'utf8')); if (Object.keys(p).every(k => k === 'updatedAt' || p[k] === old[k])) p.updatedAt = old.updatedAt; }
      fs.mkdirSync(d, { recursive: true }); atomicJson(path.join(d, 'brave-character.json'), p); return view(p.id);
    },
    install(id, game) {
      const identities = gameIdentities(game);
      const source = dir(id), target = dir(id, installedRoot);
      const p = JSON.parse(fs.readFileSync(path.join(source, 'brave-character.json'), 'utf8')); normalize(p);
      const voiceFile = p.voiceMode === 'clone' ? 'reference.wav' : 'preset-reference.wav';
      for (const f of ['head.png', voiceFile]) if (!fs.existsSync(path.join(source, f))) throw Error('جرّب صوت الشخصية قبل إضافتها.');
      fs.mkdirSync(target, { recursive: true });
      for (const f of ['head.png', 'brave-character.json']) fs.copyFileSync(path.join(source, f), path.join(target, f));
      fs.copyFileSync(path.join(source, voiceFile), path.join(target, 'voice.wav'));
      if (p.voiceMode === 'clone') fs.copyFileSync(path.join(source, 'reference.wav'), path.join(target, 'reference.wav'));
      const cached = path.join(source, 'voice-cache');
      if (p.voiceMode === 'clone' && fs.existsSync(cached) && !fs.lstatSync(cached).isSymbolicLink()) {
        fs.mkdirSync(path.join(target, 'voice-cache'), { recursive: true });
        for (const f of fs.readdirSync(cached).filter(f => /^[a-f0-9]{64}\.wav$/.test(f)).slice(0,24)) {
          const file = path.join(cached, f);
          if (fs.lstatSync(file).isFile() && fs.statSync(file).size < 8*1024*1024) fs.copyFileSync(file, path.join(target, 'voice-cache', f));
        }
      }
      atomicJson(path.join(target, 'caller.json'), caller(p, target));
      atomicJson(path.join(identities, id + '.json'), caller(p, target));
      return view(id);
    },
    disable(id, game) {
      const d = dir(id, installedRoot), file = path.join(d, 'caller.json');
      if (fs.existsSync(file) && fs.existsSync(path.join(d, 'brave-character.json'))) fs.renameSync(file, path.join(d, 'caller.disabled.json'));
      const packaged = path.join(gameIdentities(game), id + '.json');
      if (fs.existsSync(packaged) && JSON.parse(fs.readFileSync(packaged, 'utf8')).id === id) fs.unlinkSync(packaged);
      return view(id);
    },
  };
}
function gameIdentities(game) {
  if (!game || !path.isAbsolute(game) || !fs.existsSync(path.join(game, 'Scam With Your Friends.exe'))) throw Error('اختر مجلد اللعبة الصحيح.');
  const target = path.join(game, 'Scam With Your Friends_Data', 'StreamingAssets', 'kolkata-json', 'caller-identities');
  if (!fs.statSync(target).isDirectory()) throw Error('مجلد شخصيات اللعبة غير موجود.');
  return target;
}
module.exports = { createStore, normalize, caller, DIALECTS, ID };
