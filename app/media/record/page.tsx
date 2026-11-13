import type {Metadata} from "next";
import {MediaRecorderDraft} from "@/components/MediaRecorderDraft";
export const metadata:Metadata={title:"Recording draft — s3r.ch",robots:{index:false,follow:false}};
export default function RecordingPage(){return <MediaRecorderDraft/>;}
