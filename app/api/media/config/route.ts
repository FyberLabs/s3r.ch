export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public routing metadata only; credentials and backend locations never leave the server. */
export async function GET() {
  const configured=process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
  const tenant=configured && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configured) ? configured : null;
  return Response.json({tenant},{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
