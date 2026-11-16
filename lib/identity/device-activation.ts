import {importKeyring,exportCurrentPair,closeKeyring,type KeyringState} from 'sociacl-ids/keyring';
import type {Identity} from 'sea-device-link';
import type {SeaPair} from './sea';
/** Activation never writes storage. A refused issuer leaves durable import alone. */
export async function activateDeviceKeyring(bytes:Uint8Array,identity:Identity,state:KeyringState,input:{current:()=>boolean;signIn:(pair:SeaPair)=>Promise<boolean>;remember:(pair:SeaPair)=>void}){
 if(!input.current())throw Error('Identity changed');const handle=importKeyring(bytes,identity,state);
 try{const pair=exportCurrentPair(handle,state),ok=await input.signIn(pair);if(!input.current())throw Error('Identity changed');if(!ok)return false;input.remember(pair);return true;}
 finally{closeKeyring(handle);}
}
