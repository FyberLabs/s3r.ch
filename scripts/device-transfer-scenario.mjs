import assert from 'node:assert/strict';
/** Infra owns executable setup/readiness/teardown and real login/PRF drivers.
 * No storageState, injected token, fabricated identity or fallback fixture. */
export async function deviceTransferScenario({source,receiver,origin,authenticate,unlockSource,completePrf,scanQr,assertIdentityAndAccess}){
 for(const page of [source,receiver]){await page.goto(origin+'/identity/devices');await authenticate(page);}
 await source.getByRole('button',{name:'Send from this device',exact:true}).click();await unlockSource(source);
 // Exercise the physical/browser camera path first, then prove cancellation.
 await receiver.getByRole('button',{name:'Create pairing request',exact:true}).click();await completePrf(receiver);
 await receiver.getByRole('img',{name:'Pairing QR for the source device'}).waitFor();
 await source.getByRole('button',{name:'Scan receiving device QR',exact:true}).click();await scanQr({source,receiver});
 await source.getByRole('button',{name:'Confirm destination and unlock identity',exact:true}).waitFor();
 await source.getByRole('button',{name:'Cancel pairing',exact:true}).click();await receiver.getByRole('button',{name:'Cancel pairing',exact:true}).click();
 await assertIdentityAndAccess({source,receiver,imported:false});
 // Camera-free file route uses actual UI downloads, never clipboard/chat.
 for(const page of [source,receiver])await page.getByRole('button',{name:'Start a new pairing request',exact:true}).click();
 await receiver.getByRole('button',{name:'Create pairing request',exact:true}).click();await completePrf(receiver);
 const downloading=receiver.waitForEvent('download');await receiver.getByRole('button',{name:'Save pairing file',exact:true}).click();const download=await downloading;
 try{
  await source.getByLabel('Or open the receiving device’s pairing file').setInputFiles(await download.path());
  await source.getByRole('button',{name:'Confirm destination and unlock identity',exact:true}).click();await completePrf(source);
  await receiver.getByRole('button',{name:'Check source admission and offer',exact:true}).click();
  await source.getByRole('button',{name:'Connect after receiver activation',exact:true}).click();
  await receiver.getByRole('button',{name:'Check source admission and offer',exact:true}).click();
  const comparison=await source.locator('.sea-device-link > p > code').textContent(),other=await receiver.locator('.sea-device-link > p > code').textContent();assert.equal(comparison,other);assert.match(comparison,/^[a-f0-9]{8}(-[a-f0-9]{8}){7}$/);
  for(const page of [source,receiver]){await page.getByLabel('Full comparison from the other device').fill(comparison);await page.getByRole('button',{name:'Confirm identity, destination and comparison',exact:true}).click();}
  await source.getByRole('button',{name:'Send encrypted identity',exact:true}).click();
  // Lose only acknowledgement, after the atomic import has completed.
  await receiver.route('**/api/identity/device/relay',route=>route.request().postDataJSON()?.action==='complete'?route.abort():route.continue());
  await receiver.getByRole('button',{name:'Import using local protection',exact:true}).click();await receiver.getByRole('heading',{name:'Saved identity',exact:true}).waitFor();
  await receiver.unroute('**/api/identity/device/relay');await receiver.reload();
  await receiver.getByRole('button',{name:'Retry saved acknowledgement',exact:true}).click();await completePrf(receiver);
  await receiver.getByText('Saved completion acknowledged. No identity was imported again.',{exact:true}).waitFor();
  await source.getByRole('button',{name:'Check durable acknowledgement',exact:true}).click();
  await receiver.getByRole('button',{name:'Unlock saved identity and sign in',exact:true}).click();await completePrf(receiver);
  await assertIdentityAndAccess({source,receiver,imported:true});
 }finally{await download.delete();}
}
