const fs=require('fs'),crypto=require('crypto'),path=require('path');
const root=path.resolve(__dirname,'..'), sources={},artifacts={};
for(const file of fs.readdirSync(path.join(root,'plugin')).filter(f=>f.endsWith('.cs'))){
  const name='plugin/'+file;
  sources[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n')).digest('hex');
}
for(const file of ['ArabicFix.dll','ArabicPatch.exe','Mono.Cecil.dll','Mono.Cecil.Rocks.dll']){
  const name='plugin/dist/'+file;
  artifacts[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
}
fs.writeFileSync(path.join(root,'plugin/build-manifest.json'),JSON.stringify({sources,artifacts},null,2)+'\n');
