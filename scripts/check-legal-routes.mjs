// Run only inside the CI image smoke, against its disposable container.
import assert from 'node:assert/strict';
const origin=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin??''))throw Error('CI loopback origin required');
for(const [path,status] of [['/',200],['/privacy',200],['/terms',200],['/legal-route-that-does-not-exist',404]]){
  const response=await fetch(origin+path,{redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,status,path);const html=await response.text();
  assert.match(html,/href="\/privacy"[^>]*>Privacy Policy/);assert.match(html,/href="\/terms"[^>]*>Terms of Use/);
  if(path==='/privacy'||path==='/terms')assert.match(html,/Effective date: November 13, 2026/);
  if(path==='/terms')assert.match(html,/No one under 18 may use/);
}
const signal=await fetch(origin+'/api/privacy/preferences',{headers:{'Sec-GPC':'1'},signal:AbortSignal.timeout(15000)});
assert.equal(signal.status,200);assert.deepEqual(await signal.json(),{globalPrivacyControl:true,saleAllowed:false,sharingAllowed:false});
