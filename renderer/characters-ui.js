(() => {
  let selected = null, library = [], working = false, audioUrl = null, modelReady = false;
  const controls = ['charNew','charImage','charReference','charSave','charPreview','charInstall','charTrial','charDisable','charRestoreTrial','charModelDownload'];
  const fields = { name:'charName', traits:'charTraits', background:'charBackground', opening:'charOpening', dialect:'charDialect', gender:'charGender', trust:'charTrust', voiceMode:'charVoiceMode', voicePreset:'charVoicePreset', voiceSpeed:'charVoiceSpeed', voiceQuality:'charVoiceQuality', mouthWidth:'charMouthWidth' };
  let mouthX=.54,mouthY=.69;
  function mouthControls() {
    const enabled=$('charMouth').checked;
    $('charMouthOptions').hidden=!enabled;$('charMouthMarker').hidden=!enabled||!selected?.image;
    $('charFace').disabled=enabled;if(enabled)$('charFace').checked=false;
    const image=$('charPortrait'),box=image.getBoundingClientRect();
    const scale=image.naturalWidth?Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight):1;
    const w=image.naturalWidth?image.naturalWidth*scale:box.width,h=image.naturalHeight?image.naturalHeight*scale:box.height;
    $('charMouthMarker').style.left=((box.width-w)/2+mouthX*w)+'px';$('charMouthMarker').style.top=((box.height-h)/2+mouthY*h)+'px';
  }
  function status(text, bad = false) { $('charStatus').textContent = text; $('charStatus').classList.toggle('error', bad); }
  function buttons() {
    controls.forEach(id => $(id).disabled = working);
    $('charTrial').disabled = working || !selected?.current;
    $('charDisable').disabled = working || !selected?.installed;
    $('charModelDownload').disabled = working || modelReady;
  }
  function showVoiceMode() { const clone = $('charVoiceMode').value === 'clone'; $('charClonePanel').hidden = !clone; $('charPresetRow').hidden = clone; }
  function stopAudio() { $('charAudio').pause(); $('charAudio').hidden = true; if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; }
  function edit(p) {
    selected = p; stopAudio();
    const values = { name:'', traits:'', background:'', opening:'', dialect:'gulf_saudi', gender:'Male', trust:40, voiceMode:'preset', voicePreset:'M1', voiceSpeed:1,voiceQuality:'balanced',mouthWidth:.32,...p };
    for (const [key,id] of Object.entries(fields)) $(id).value = values[key];
    $('charConsent').checked = p.voiceConsent === true; $('charFace').checked = p.faceFeatures === true;
    $('charMouth').checked=p.mouthAnimation===true;mouthX=p.mouthX??.54;mouthY=p.mouthY??.69;mouthControls();
    $('charBrief').checked=p.shortReplies===true;
    $('charHeading').textContent = p.name || 'شخصية جديدة';
    $('charPortrait').hidden = !p.image; $('charPortraitEmpty').hidden = !!p.image;
    if (p.image) $('charPortrait').src = p.image; else $('charPortrait').removeAttribute('src');
    $('charReferenceState').textContent = p.hasReference ? 'تسجيل الصوت جاهز ومحفوظ محليًا.' : 'لم يُضف تسجيل بعد.';
    showVoiceMode(); renderLibrary(); buttons();
    status(p.installed ? (p.current ? 'الشخصية مضافة للعبة. يمكنك تجربتها وحدها.' : 'هناك تعديلات محفوظة؛ أعد إضافتها لتحديث اللعبة.') : 'احفظ وجرّب الصوت، ثم أضف الشخصية إلى اللعبة.');
  }
  function renderLibrary() {
    $('charList').replaceChildren();
    if (!library.length) { const empty=document.createElement('p'); empty.className='note'; empty.textContent='شخصياتك المحفوظة تظهر هنا.'; $('charList').append(empty); }
    for (const p of library) {
      const button=document.createElement('button'); button.className='character-item'+(p.id===selected?.id?' active':''); button.disabled=working;
      if (p.image) { const img=document.createElement('img');img.src=p.image;img.alt='';button.append(img); }
      const label=document.createElement('span'), name=document.createElement('b'), detail=document.createElement('small');
      name.textContent=p.name; detail.textContent=(p.voiceMode==='clone'?'صوت مستنسخ بإذن':'صوت جاهز')+' · '+(p.current?'مضافة':p.installed?'تحتاج تحديث':'محفوظة');
      label.append(name,detail);button.append(label);button.addEventListener('click',()=>edit(p));$('charList').append(button);
    }
  }
  async function refresh() {
    const result=await window.api.charactersList(); if (!result?.ok) throw Error(result?.error||'تعذّر تحميل الشخصيات.');
    if (window.api.characterModelStatus) { const m=await window.api.characterModelStatus(); modelReady=m.installed===true; }
    $('charModelState').textContent=modelReady?'نموذج الصوت المخصص جاهز. يعمل محليًا؛ قد تنتظر عدة ثوانٍ لكل رد جديد، خصوصًا على الأجهزة الأقدم.':'تنزيل مرة واحدة (2.1 جيجابايت)، وبعدها يعمل دون إنترنت أو رسوم API. اختياري؛ الأصوات الجاهزة أسرع.';
    library=result.characters; $('charTrialNotice').hidden=!result.trial;
    if (selected) selected=library.find(x=>x.id===selected.id)||selected;
    renderLibrary(); buttons();
  }
  async function ensureDraft() {
    if (!selected) { const r=await window.api.characterNew(); if(!r.ok)throw Error(r.error); selected={id:r.id}; }
  }
  function form() { const p={id:selected.id};for(const [key,id]of Object.entries(fields))p[key]=$(id).value;p.voiceConsent=$('charConsent').checked;p.faceFeatures=$('charFace').checked;p.mouthAnimation=$('charMouth').checked;p.mouthX=mouthX;p.mouthY=mouthY;p.shortReplies=$('charBrief').checked;return p; }
  async function save() { await ensureDraft(); const r=await window.api.characterSave(form());if(!r.ok)throw Error(r.error);selected=r.character;await refresh();return selected; }
  async function job(fn, message) {
    if(working)return; working=true;buttons();renderLibrary();if(message)status(message);
    try { await fn(); } catch(e) { status(e.message,true); } finally {working=false;buttons();renderLibrary();}
  }
  $('charVoiceMode').addEventListener('change',showVoiceMode);
  $('charMouth').addEventListener('change',mouthControls);
  $('charPortrait').addEventListener('load',mouthControls);
  $('charPortrait').addEventListener('click',e=>{
    if(!$('charMouth').checked)return;
    const box=e.target.getBoundingClientRect(),scale=Math.min(box.width/e.target.naturalWidth,box.height/e.target.naturalHeight);
    const w=e.target.naturalWidth*scale,h=e.target.naturalHeight*scale;
    mouthX=Math.max(.05,Math.min(.95,(e.clientX-box.left-(box.width-w)/2)/w));mouthY=Math.max(.05,Math.min(.95,(e.clientY-box.top-(box.height-h)/2)/h));mouthControls();if(selected)selected.current=false;buttons();status('تم تحديد مكان الفم. احفظ ثم أعد إضافة الشخصية لتحديث اللعبة.');
  });
  for(const el of document.querySelectorAll('#characters input,#characters textarea,#characters select')) el.addEventListener('input',()=>{if(selected)selected.current=false;buttons();});
  $('charModelDownload').addEventListener('click',()=>job(async()=>{const r=await window.api.characterModelDownload();if(!r.ok)throw Error(r.error);await refresh();status('النموذج جاهز. احفظ الشخصية واسمع أول جملة.');},'جاري تنزيل نموذج الصوت المخصص والتحقق منه… قد يستغرق عدة دقائق حسب الإنترنت.'));
  $('charNew').addEventListener('click',()=>job(async()=>{const r=await window.api.characterNew();if(!r.ok)throw Error(r.error);edit({id:r.id});}));
  $('charImage').addEventListener('click',()=>job(async()=>{await ensureDraft();const r=await window.api.characterImage(selected.id);if(!r.ok)throw Error(r.error);if(!r.canceled){selected.image=r.image;$('charPortrait').src=r.image;$('charPortrait').hidden=false;$('charPortraitEmpty').hidden=true;status('الصورة جاهزة. أكمل الصفات واحفظ الشخصية.');}}));
  $('charReference').addEventListener('click',()=>job(async()=>{await ensureDraft();const r=await window.api.characterReference(selected.id,$('charConsent').checked);if(!r.ok)throw Error(r.error);if(!r.canceled){selected.hasReference=true;$('charReferenceState').textContent=`تسجيل جاهز: ${r.seconds} ثانية، محفوظ على جهازك.`;status('التسجيل جاهز. احفظ الشخصية ثم اسمع أول جملة.');}},'جاري تجهيز التسجيل…'));
  $('charSave').addEventListener('click',()=>job(async()=>{await save();status('حُفظت الشخصية.');}));
  $('charPreview').addEventListener('click',()=>job(async()=>{
    const p=await save();stopAudio();status(p.voiceMode==='clone'?'جاري تجهيز الصوت المستنسخ… قد يستغرق حتى دقيقتين على الأجهزة الأضعف.':'جاري توليد أول جملة…');
    const r=await window.api.characterPreview(p.id,state.game,p.opening);if(!r.ok)throw Error(r.error);
    const bytes=Uint8Array.from(atob(r.audio),c=>c.charCodeAt(0));audioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));$('charAudio').src=audioUrl;$('charAudio').hidden=false;
    status(`المعاينة جاهزة: ${r.audio_seconds} ثانية صوت، والتجهيز ${r.seconds} ثانية. ${r.cloned?'صوت مستنسخ تجريبي؛ استمع وتأكد من التشابه والوضوح.':''}`);
  }));
  $('charInstall').addEventListener('click',()=>job(async()=>{const p=await save();const r=await window.api.characterInstall(p.id,state.game);if(!r.ok)throw Error(r.error);selected=r.character;await refresh();status('أُضيفت الشخصية. افتح اللعبة، أو اضغط «جرّب هذه الشخصية وحدها» قبل فتحها.');},'جاري إضافة الشخصية…'));
  $('charTrial').addEventListener('click',()=>job(async()=>{const r=await window.api.characterTrial(selected.id);if(!r.ok)throw Error(r.error);await refresh();status('جاهزة للتجربة: افتح اللعبة وابدأ مكالمة. أعد المكالمات العادية من الزر الموجود في المكتبة بعد الانتهاء.');}));
  $('charRestoreTrial').addEventListener('click',()=>job(async()=>{const r=await window.api.characterTrialRestore();if(!r.ok)throw Error(r.error);await refresh();status('رجعت قائمة المكالمات السابقة.');}));
  $('charDisable').addEventListener('click',()=>job(async()=>{const r=await window.api.characterDisable(selected.id,state.game);if(!r.ok)throw Error(r.error);selected=r.character;await refresh();status('أُزيلت من اللعبة، وبقيت محفوظة في مكتبتك.');}));
  document.querySelectorAll('.nav-item').forEach(button=>button.addEventListener('click',()=>{
    if(button.dataset.tab==='characters')job(async()=>{await refresh();if(!selected&&library.length)edit(library[0]);});else stopAudio();
  }));
  showVoiceMode();buttons();
})();
