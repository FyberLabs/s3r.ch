import { roomWebhookRequest } from "@/lib/room-webhook-server";
export const runtime = "nodejs";
export const POST = (request: Request) => roomWebhookRequest(request, "manage");
