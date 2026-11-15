import type {Metadata} from 'next';
import {ContactsWorkspace} from '@/components/ContactsWorkspace';
import {parseMediaReaderConfig} from '@/lib/media-wrap-service';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Contacts — s3r.ch',robots:{index:false,follow:false}};
export default function ContactsPage(){
 let origin:string|null=null;
 try{const raw=process.env.S3RCH_CONTACT_READER_BINDINGS;if(raw)origin=parseMediaReaderConfig(raw).origin;}catch{/* Invalid configuration keeps contacts unavailable. */}
 return <ContactsWorkspace origin={origin}/>;
}
