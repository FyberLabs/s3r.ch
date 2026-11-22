import { roomWebhookRequest } from "@/lib/room-webhook-server";
export const runtime = "nodejs";
export const GET = (request: Request) => roomWebhookRequest(request, "inbox");
