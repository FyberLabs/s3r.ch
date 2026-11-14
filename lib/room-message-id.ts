/** Shape check only; message authenticity is established by room admission. */
export const signedRoomMessageId = (id: unknown): id is string =>
  typeof id === "string" && /^s3rch:chat:[0-9a-f]{64}$/.test(id);
