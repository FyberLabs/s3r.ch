import { servePublicMedia } from "@/lib/public-media-proxy";
import { mediaAdmission } from "@/lib/public-media-admission";
import { listSnapshot } from "@/lib/gun-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let sign;
  try { sign=mediaAdmission(process.env.IDENTITY_SESSION_SECRET??"",listSnapshot().items)(request); }
  catch { return new Response("Media unavailable",{status:503}); }
  if(!sign)return new Response("Media not admitted",{status:403});
  return servePublicMedia(request,undefined,sign);
}
