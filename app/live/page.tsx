import type {Metadata} from "next";
import {LiveDirectory} from "@/components/LiveDirectory";
export const metadata:Metadata={title:"Live streams — s3r.ch"};
export default function LivePage(){return <main className="mx-auto max-w-4xl space-y-5 px-4 py-8"><h1 className="text-2xl font-semibold">Live streams</h1><LiveDirectory/></main>;}
