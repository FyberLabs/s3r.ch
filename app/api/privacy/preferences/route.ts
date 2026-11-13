import { privacyPreferences } from "@/lib/privacy-preferences";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return Response.json(privacyPreferences(request.headers.get("Sec-GPC")), {
    headers: { "Cache-Control": "private, no-store", Vary: "Sec-GPC", "X-Content-Type-Options": "nosniff" },
  });
}
