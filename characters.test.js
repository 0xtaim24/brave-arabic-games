const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'), path=require('path'), os=require('os');
const {createStore,normalize}=require('./characters');
function fixture(fn) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'brave-character-test-'));
  try {
    const game=path.join(base,'game');fs.mkdirSync(path.join(game,'Scam With Your Friends_Data/StreamingAssets/kolkata-json/caller-identities'),{recursive:true});fs.writeFileSync(path.join(game,'Scam With Your Friends.exe'),'fixture');
    const store=createStore(path.join(base,'library'),path.join(base,'installed'));
    const id=store.allocate();const png=Buffer.alloc(40);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);store.image(id,png);
    const p={id,name:'شخصية تجريبية',traits:'هادئ ويسأل عند الغموض',background:'شخصية خيالية',opening:'أهلًا، كيف حالك؟',trust:40,gender:'Male',dialect:'gulf_saudi',voiceMode:'preset',voicePreset:'M3',voiceConsent:false};
    fn(store,p,game,base);
  } finally {
    assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('brave-character-test-'));fs.rmSync(base,{recursive:true,force:true});
  }
}
test('cloning requires explicit permission; plain voices do not',()=>fixture((store,p)=>{
  assert.throws(()=>normalize({...p,voiceMode:'clone'}),/صوتك/);assert.equal(normalize(p).voiceMode,'preset');
}));
test('profile identifiers cannot access another directory',()=>fixture(store=>{
  for(const id of ['../elsewhere','brave-../../a','C:\\Windows','brave-'+ 'a'.repeat(31)])assert.throws(()=>store.dir(id));
}));
test('install preserves other callers and gives each character a fixed voice and caller role',()=>fixture((store,p,game)=>{
  const other=path.join(game,'Scam With Your Friends_Data/StreamingAssets/kolkata-json/caller-identities/other.json');fs.writeFileSync(other,'unchanged');
  store.save(p);fs.writeFileSync(path.join(store.dir(p.id),'preset-reference.wav'),'fixture');store.install(p.id,game);
  const caller=JSON.parse(fs.readFileSync(path.join(store.dir(p.id,store.installedRoot),'caller.json'),'utf8'));
  assert.equal(caller.callType,'victim');assert.equal(caller.initialTrustPercent,40);assert.equal(caller.showFaceFeatures,false);assert.ok(caller.voiceId.includes(p.id));assert.equal(fs.readFileSync(other,'utf8'),'unchanged');
  const before=store.view(p.id);assert.equal(before.current,true);store.save(p);assert.equal(store.view(p.id).current,true);
  store.disable(p.id,game);assert.equal(store.view(p.id).installed,false);assert.ok(fs.existsSync(path.join(store.dir(p.id),'brave-character.json')));assert.equal(fs.readFileSync(other,'utf8'),'unchanged');
}));
test('invalid game path cannot leave a half-installed caller',()=>fixture((store,p,game,base)=>{
  store.save(p);fs.writeFileSync(path.join(store.dir(p.id),'preset-reference.wav'),'fixture');assert.throws(()=>store.install(p.id,path.join(base,'other')));assert.equal(fs.existsSync(path.join(store.dir(p.id,store.installedRoot),'caller.json')),false);
}));
test('image import rejects unsupported or oversized dimensions',()=>fixture((store,p)=>{
  assert.throws(()=>store.image(p.id,Buffer.from('not png')));const png=Buffer.alloc(40);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(90000,16);png.writeUInt32BE(64,20);assert.throws(()=>store.image(p.id,png));
}));
