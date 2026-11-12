import { toolRegistryResponse } from "@/lib/tool-registry-server";
export const runtime = "nodejs";
export async function GET(request: Request) { return toolRegistryResponse(request); }
