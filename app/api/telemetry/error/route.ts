import { ingestCrash } from "@/lib/crash-ingestion";
import { recordError } from "@/lib/release-telemetry-server";
export const runtime = "nodejs";
export async function POST(request: Request) { return ingestCrash(request,recordError); }
