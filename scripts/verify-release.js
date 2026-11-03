const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'), pkg=require('../package.json');
const hash=(file,algorithm='sha256',encoding='hex')=>crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
assert.match(pkg.version,/^\d+\.\d+\.\d+$/,'Public releases must use a stable version');
assert.equal(require('../package-lock.json').version,pkg.version);
assert.equal(require('../package-lock.json').packages[''].version,pkg.version);
assert.equal(pkg.build.publish.owner,'0xtaim24');assert.equal(pkg.build.publish.repo,'brave-arabic-games');
if(process.env.GITHUB_REF_TYPE==='tag')assert.equal(process.env.GITHUB_REF_NAME,'v'+pkg.version);
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
for(const file of files){
  assert(!/(^|\/)(?:characters|voice-cache|samples|MetaSave|\.claude)(\/|$)/i.test(file),'Private folder: '+file);
  assert(!/(?:^|\/)(?:reference\.wav|voice\.wav|head\.png|brave-character\.json|settings\.json|user-overrides\.json|\.env(?:\..*)?)$/i.test(file),'Private file: '+file);
  if(/\.(?:wav|mp3|ogg|flac|m4a|mp4)$/i.test(file))assert.equal(file,'data/bench-ar.wav','Unexpected media: '+file);
  assert(!/(?:Assembly-CSharp|ScriptsAssDef|UnityEngine[^/]*|mscorlib)\.dll$/i.test(file),'Game assembly: '+file);
  if(/\.(?:js|py|cs|ps1|json|md|html|yml)$/i.test(file)){
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert(!/C:[\\/]+Users[\\/]+[^\\/\s<>]+[\\/]/i.test(text),'Private absolute path: '+file);
    assert(!/(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text),'Potential credential: '+file);
  }
}
const manifest=require('../plugin/build-manifest.json');
for(const [file,expected]of Object.entries(manifest.sources))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n')).digest('hex'),expected,'Rebuild C# after changing '+file);
for(const [file,expected]of Object.entries(manifest.artifacts))assert.equal(hash(path.join(root,file)),expected,'Plugin binary mismatch: '+file);
if(process.argv[2]){
  const dist=path.resolve(process.argv[2]), yaml=require('js-yaml');
  const update=yaml.load(fs.readFileSync(path.join(dist,'latest.yml'),'utf8'));
  const name='brave-Setup-'+pkg.version+'.exe', exe=path.join(dist,name);
  assert.equal(update.version,pkg.version);assert.equal(update.path,name);assert.equal(update.sha512,hash(exe,'sha512','base64'));
  assert.equal(update.files.length,1);assert.equal(update.files[0].url,name);assert.equal(update.files[0].sha512,update.sha512);assert.equal(update.files[0].size,fs.statSync(exe).size);
  assert(fs.statSync(exe+'.blockmap').size>0);
  const resources=path.join(dist,'win-unpacked/resources'), asar=require('@electron/asar');
  const appFiles=asar.listPackage(path.join(resources,'app.asar'));
  assert(!appFiles.some(f=>/[\\/](characters|voice-cache)[\\/]|brave-character\.json|reference\.wav/i.test(f)),'Personal assets in application');
  const embedded=JSON.parse(asar.extractFile(path.join(resources,'app.asar'),'package.json').toString());assert.equal(embedded.version,pkg.version);
  const config=yaml.load(fs.readFileSync(path.join(resources,'app-update.yml'),'utf8'));
  assert.equal(config.provider,'github');assert.equal(config.owner,pkg.build.publish.owner);assert.equal(config.repo,pkg.build.publish.repo);
  const dataFiles=fs.readdirSync(path.join(resources,'data')).sort();assert.deepEqual(dataFiles,['bench-ar.txt','bench-ar.wav','overrides.ar.json']);
  assert(fs.existsSync(path.join(resources,'fix/character-native/LICENSE-audio-cpp.txt')));
  assert(fs.existsSync(path.join(resources,'fix/stt-native/warmup-ar.wav')));
  fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),[name,name+'.blockmap','latest.yml'].map(f=>hash(path.join(dist,f))+'  '+f).join('\n')+'\n');
}
console.log('Release audit passed: '+pkg.version);
