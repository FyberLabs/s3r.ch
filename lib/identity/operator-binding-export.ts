import type { SeaPair } from './sea';
import { operatorBindingStatement, verifyOperatorBinding } from './operator-binding';

const wallet = '0x4C8d36f87287e75D3D84F1aeD72655ecCbC7A1A7';
const domain = 'test.s3r.ch';
export async function exportOperatorBinding(input: {
  address: string; origin: string; pair: SeaPair; current: () => boolean;
  signWallet: (message: string) => Promise<string>; timestamp: number;
}): Promise<string> {
  try {
    if (input.address !== wallet || input.origin !== `https://${domain}` || !input.current()) throw Error();
    const pair = input.pair;
    const row = {version: 1 as const, purpose: 's3rch-operator-binding/v1' as const,
      domain, wallet, sea_public_key: pair.pub, timestamp: input.timestamp};
    const wallet_signature = await input.signWallet(operatorBindingStatement(row, 'wallet-to-sea'));
    if (!input.current()) throw Error();
    const sea_signature = await signOperatorSeaStatement(pair, row, input.current);
    const proof = {...row,wallet_signature,sea_signature};
    const declared = {domain,wallet,sea_public_key:pair.pub};
    if (!input.current() || !await verifyOperatorBinding([proof],declared) || !input.current()) throw Error();
    return JSON.stringify({version:1,enabled:false,declared,proofs:[proof]},null,2)+'\n';
  } catch { throw Error('Operator binding was not exported. Unlock the existing identity and retry.'); }
}

export async function signOperatorSeaStatement(pair: SeaPair, row: Parameters<typeof operatorBindingStatement>[0], current: () => boolean): Promise<string> {
    if (row.sea_public_key !== pair.pub || !current()) throw Error("Identity changed");
    const [x,y] = pair.pub.split('.');
    const key = await crypto.subtle.importKey('jwk', {kty:'EC',crv:'P-256',x,y,d:pair.priv,ext:false},
      {name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    if (!current()) throw Error();
    const raw = new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,
      new TextEncoder().encode(operatorBindingStatement(row, 'sea-to-wallet'))));
    return btoa(String.fromCharCode(...raw)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
