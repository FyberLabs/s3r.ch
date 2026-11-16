// CI-only preparation of the exact owner packages consumed by this application.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Package preparation requires CI');
const root=process.cwd(),out=resolve('vendor/pairing'),temp=mkdtempSync(join(tmpdir(),'s3rch-pairing-'));
const inputs=[
 ['hyperme-sh/controlplane-sdk','006611d80fe60b303288447204271cde5ba35332','packages/sea-device-link','sea-device-link'],
 ['hyperme-sh/auth-service','24a1b061106838673e5b98facd68f4a0593342b1','browser/sea-relay','auth-sea-relay'],
 ['FyberLabs/SociACL','3c36a3db8fdfebbf494f24c6a8fef59c47b867f6','typescript/ids','sociacl-ids'],
 ['hyperme-sh/acl-service','5519668e201bd2fc472f99c21ad977e810a00dc3','browser/device-transfer','acl-sea-device-authority'],
 ['hyperme-sh/controlplane-portal','70f197f1871344382d769bc6b8a30349e8ead8f4','packages/sea-device-link-ui','sea-device-link-ui'],
];
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,stdio:'inherit'});
mkdirSync(out,{recursive:true});const manifest=[];const files={};
try{
 for(const [repo,revision,path,name] of inputs){
  const checkout=join(temp,name),cwd=join(checkout,path);
  if(name==='sea-device-link-ui'){
   const archive=join(out,'ui-source.tar');
   if(createHash('sha256').update(readFileSync(archive)).digest('hex')!=='3fb364fc72bb8d7c7bd37247d49e5733590ed7a687349699819546a7cb0de75a')throw Error('UI source digest mismatch');
   mkdirSync(cwd,{recursive:true});run('tar',['-xf',archive,'-C',cwd],root);
  }else{run('git',['clone','--no-checkout','https://github.com/'+repo+'.git',checkout],root);run('git',['checkout','--detach',revision],checkout);}
  if(name==='sea-device-link'||name==='sociacl-ids'){run('npm',['ci','--ignore-scripts'],cwd);run('npm',['run','build'],cwd);}
  if(name==='sea-device-link-ui'){
   run('npm',['install','--no-save','--ignore-scripts','--package-lock=false','--no-audit',files['sea-device-link'],files['auth-sea-relay'],'react@19.2.3','react-dom@19.2.3'],cwd);
   run('npm',['run','build'],cwd);
  }
  const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd,encoding:'utf8'}))[0];
  files[name]=join(out,packed.filename);
  manifest.push({name,repository:repo,revision,path,file:packed.filename,sha256:createHash('sha256').update(readFileSync(files[name])).digest('hex')});
 }
 writeFileSync(join(out,'sources.json'),JSON.stringify({version:1,packages:manifest},null,2)+'\n');
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 for(const item of manifest)pkg.dependencies[item.name]='file:vendor/pairing/'+item.file;
 writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
 // File packages can change bytes while retaining their owner version. Remove
 // only their stale lock entries so npm reads the freshly packed manifests.
 const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
 for(const item of manifest)delete lock.packages['node_modules/'+item.name];
 writeFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\n');
 run('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],root);
 mkdirSync('pairing-prepared',{recursive:true});cpSync('vendor/pairing','pairing-prepared/vendor/pairing',{recursive:true});
 cpSync('package.json','pairing-prepared/package.json');cpSync('package-lock.json','pairing-prepared/package-lock.json');
}finally{rmSync(temp,{recursive:true,force:true});}
