import type {Metadata} from "next";
import {MemeEditor} from "@/components/MemeEditor";
export const metadata:Metadata={title:"Image draft editor — s3r.ch",robots:{index:false,follow:false}};
export const dynamic="force-dynamic";
export default function ImageEditorPage(){
 const tenant=process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
 return <MemeEditor tenant={tenant&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenant)?tenant:null}/>;
}
