import {getAddress} from 'viem';
import type {LinkedWalletSelection} from './linked-wallet-client';
export type RecoveryWalletProvider={request:(args:{method:string;params?:unknown[]})=>Promise<unknown>;
 on:(event:string,listener:()=>void)=>void;removeListener:(event:string,listener:()=>void)=>void};
/** Event revisions catch away-and-back changes even while a wallet prompt is open. */
export async function connectRecoveryWallet(provider:RecoveryWalletProvider,signal:AbortSignal,onChange:()=>void){
 if(!provider||typeof provider.request!=='function'||typeof provider.on!=='function'||typeof provider.removeListener!=='function')throw Error('Browser wallet unavailable');
 let revision=0,closed=false,connected=false,selected:LinkedWalletSelection|null=null;
 const changed=()=>{revision++;selected=null;if(connected)onChange();};
 const events=['accountsChanged','chainChanged','disconnect'];
 const close=()=>{if(closed)return;closed=true;selected=null;revision++;for(const event of events)provider.removeListener(event,changed);signal.removeEventListener('abort',close);};
 const guard=()=>{signal.throwIfAborted();if(closed)throw Error('Wallet closed');};
 for(const event of events)provider.on(event,changed);signal.addEventListener('abort',close,{once:true});
 const selection=async(method:string)=>{const accounts=await provider.request({method});guard();const seen=revision,chain=await provider.request({method:'eth_chainId'});guard();if(seen!==revision)throw Error('Wallet selection changed');
  if(!Array.isArray(accounts)||accounts.length!==1||typeof accounts[0]!=='string'||typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain))throw Error('Select one linked wallet');
  const chainId=BigInt(chain);if(chainId<=0n||chainId>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Wallet chain unavailable');
  return {address:getAddress(accounts[0]),chainId:chainId.toString()};
 };
 try{
  guard();const account=await selection('eth_requestAccounts');guard();connected=true;
  selected=Object.freeze({...account,walletRevision:revision,sessionRevision:0});
  return Object.freeze({close,current:()=>!closed&&!signal.aborted?selected:null,
   async signMessage(message:string,expected:LinkedWalletSelection){
    const check=()=>{guard();if(!selected||selected.address!==expected.address||selected.chainId!==expected.chainId||selected.walletRevision!==expected.walletRevision||selected.sessionRevision!==expected.sessionRevision)throw Error('Wallet selection changed');};
    check();const account=await selection('eth_accounts');check();if(account.address!==expected.address||account.chainId!==expected.chainId)throw Error('Wallet selection changed');
    const data='0x'+Array.from(new TextEncoder().encode(message),b=>b.toString(16).padStart(2,'0')).join('');
    const signature=await provider.request({method:'personal_sign',params:[data,expected.address]});check();
    const after=await selection('eth_accounts');check();if(after.address!==expected.address||after.chainId!==expected.chainId||typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw Error('Wallet signature unavailable');
    return signature;
   },
  });
 }catch(error){close();throw error;}
}
