import { listSnapshot } from "@/lib/gun-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (process.env.GUN_EXTERNAL_PEER === "1") {
    return Response.redirect(new URL("/feed-cache/snapshot.json", request.url), 307);
  }
  const snapshot = listSnapshot();
  return Response.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
