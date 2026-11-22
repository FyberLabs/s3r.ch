export const ROOM_WEBHOOK_CALLBACK_PATH = "/api/rooms/webhooks/receive";

export function roomWebhookCallback(origin: string): string | null {
  if (origin !== "https://test.s3r.ch" && origin !== "https://s3r.ch") return null;
  return origin + ROOM_WEBHOOK_CALLBACK_PATH;
}
