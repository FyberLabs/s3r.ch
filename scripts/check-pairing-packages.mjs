import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),manifest=JSON.parse(readFileSync(new URL('vendor/pairing/sources.json',root))),pkg=JSON.parse(readFileSync(new URL('package.json',root)));
const expected=['acl-sea-device-authority','auth-sea-relay','sea-device-link','sea-device-link-ui','sociacl-ids'];
if(manifest.version!==1||manifest.packages.map(p=>p.name).sort().join()!==expected.join())throw Error('Pairing package manifest mismatch');
for(const p of manifest.packages){
 if(!/^[a-f0-9]{40}$/.test(p.revision)||!/^[a-z0-9.-]+\.tgz$/.test(p.file)||pkg.dependencies[p.name]!=='file:vendor/pairing/'+p.file)throw Error('Pairing package provenance mismatch');
 if(createHash('sha256').update(readFileSync(new URL('vendor/pairing/'+p.file,root))).digest('hex')!==p.sha256)throw Error('Pairing package digest mismatch');
}
