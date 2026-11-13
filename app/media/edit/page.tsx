import type {Metadata} from "next";
import {MemeEditor} from "@/components/MemeEditor";
export const metadata:Metadata={title:"Image draft editor — s3r.ch",robots:{index:false,follow:false}};
export default function ImageEditorPage(){return <MemeEditor/>;}
