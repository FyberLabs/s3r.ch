import { servePublicMedia } from "@/lib/public-media-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return servePublicMedia(request); }
