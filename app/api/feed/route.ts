export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return new Response(null, { status: 307, headers: { Location: "/feed-cache/snapshot.json" } });
}
