import { releaseContext } from "@/lib/release-telemetry-server";
export const dynamic = "force-dynamic";
export function GET() { return Response.json(releaseContext(), {headers:{"Cache-Control":"no-store"}}); }
