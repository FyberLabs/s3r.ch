import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retired = () => Response.json({ error: "site-forum-acl-retired" }, {
  status: 503,
  headers: { "Cache-Control": "no-store" },
});

async function nativeGET() {
  return retired();
}

async function nativePOST() {
  return retired();
}

export const GET = withConfiguredTerminalHandler(nativeGET);
export const POST = withConfiguredTerminalHandler(nativePOST);