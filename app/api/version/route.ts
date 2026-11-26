import { buildRevision } from "@/lib/build-revision";

export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ revision: buildRevision() }, { headers: { "Cache-Control": "no-store" } });
}
