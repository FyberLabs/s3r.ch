import {mkdir,writeFile} from 'node:fs/promises';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const base='https://raw.githubusercontent.com/FyberLabs/SociACL/85d553dda2e7199a899b8807d09d21e8a0318837/vectors/';
const target=new URL('../lib/.pairing-test-vectors/',import.meta.url);await mkdir(target,{recursive:true});
for(const [name,path] of Object.entries({'browser-keyring':'encrypted-discovery/browser-keyring.json','account-keyring':'encrypted-discovery/account-keyring.json',records:'ids/records.json','recovery-copy':'encrypted-discovery/recovery-copy.json','recovery-legacy-strength':'encrypted-discovery/recovery-legacy-strength.json'})){
 const response=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Public synthetic vectors unavailable');
 const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>4*1024*1024)throw Error('Oversized fixture');await writeFile(new URL(name+'.json',target),bytes,{mode:0o600});
}
