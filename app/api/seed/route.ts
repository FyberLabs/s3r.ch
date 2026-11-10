export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The edge routes authenticated seed requests to the standalone peer.
export async function POST() {
  return Response.json({ error: "Route seed requests to the configured bootstrap peer." }, { status: 503 });
}
