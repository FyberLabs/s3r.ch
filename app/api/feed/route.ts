import { listSnapshot } from "@/lib/gun-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (process.env.GUN_EXTERNAL_PEER === "1") {
    return new Response(null, { status: 307, headers: { Location: "/feed-cache/snapshot.json" } });
  }
  const snapshot = listSnapshot();
  return Response.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
