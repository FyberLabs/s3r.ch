export const dynamic = "force-dynamic";
export function GET() {
  const revision = process.env.APP_BUILD_REVISION ?? "";
  return Response.json({ revision: /^[0-9a-f]{40}$/.test(revision) ? revision : null }, { headers: { "Cache-Control": "no-store" } });
}
