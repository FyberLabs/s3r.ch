import { servePublicMedia } from "@/lib/public-media-proxy";
import { mediaAdmission, publicMediaBudget } from "@/lib/public-media-admission";
import { publicMediaSnapshot } from "@/lib/public-media-snapshot";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if(!publicMediaBudget.request())return new Response("Media quota exhausted",{status:429,headers:{"retry-after":"60"}});
  let sign;
  try { sign=mediaAdmission(process.env.IDENTITY_SESSION_SECRET??"",publicMediaSnapshot())(request); }
  catch { return new Response("Media unavailable",{status:503}); }
  if(!sign)return new Response("Media not admitted",{status:403});
  return servePublicMedia(request,undefined,sign,true);
}
