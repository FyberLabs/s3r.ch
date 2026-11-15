// Isolated UI contract only. Identity, authority, journal and transport adapters
// are substitutions. This is not hosted contact or cryptographic qualification.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContactInbox} from '../../components/ContactInbox';
import type {ContactInboxSession,ContactMessageView} from '../../lib/contact-inbox-view';
let accepted=false,blocked=false,locked=false,failOnce=true,prepared=0,submitted=0;
const rows:ContactMessageView[]=[],listeners=new Set<()=>void>();
const peer='fixture-bob',owner='fixture-alice';
function changed(){for(const listener of listeners)listener();}
const session:ContactInboxSession={id:'fixture-session-alice',principal:owner,
 subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},current:()=>!locked,
 async load(){return{requests:accepted||blocked?[]:[{id:'request-bob',sender:peer,message:'Hello Alice'}],contacts:accepted?[{principal:peer,blocked}]:[]};},
 async accept(id,signal){signal.throwIfAborted();if(id!=='request-bob'||blocked||locked)throw Error();accepted=true;},
 async reject(id,signal){signal.throwIfAborted();if(id!=='request-bob')throw Error();blocked=true;},
 async block(principal,signal){signal.throwIfAborted();if(principal!==peer)throw Error();blocked=true;},
 async messages(principal,signal){signal.throwIfAborted();if(principal!==peer||blocked||locked)throw Error();return [...rows];},
 async prepareMessage(principal,text,signal){signal.throwIfAborted();if(principal!==peer||blocked||locked||!accepted)throw Error();prepared++;
   const id='fixture-message-'+prepared;let committed=false;
   return{async submit(deadline){deadline.throwIfAborted();if(blocked||locked)throw Error();submitted++;
     if(!committed){rows.push({id,sender:owner,body:text});committed=true;}
     if(failOnce){failOnce=false;throw Error('Simulated lost acknowledgement');}
   }};
 }
};
Object.assign(window,{contactFixture:{counts:()=>({prepared,submitted,rows:rows.length}),lock:()=>{locked=true;changed();},peerMessage:()=>{
 if(!accepted||blocked)throw Error('Blocked');rows.push({id:'peer-reply',sender:peer,body:'Hello back'});changed();},reset:()=>{accepted=false;blocked=false;locked=false;rows.length=0;failOnce=true;prepared=0;submitted=0;changed();}}});
function Fixture(){const [other,setOther]=useState(false);return <>
 <h1>Isolated contacts UI</h1><button onClick={()=>setOther(value=>!value)}>Switch identity</button>
 <ContactInbox session={other?{...session,id:'fixture-session-other',principal:'fixture-other',load:async()=>({requests:[],contacts:[]})}:session}/>
 </>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
