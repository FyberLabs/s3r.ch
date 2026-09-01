/** SEED_SECRET bearer check for `/api/seed` only. User login is `lib/identity/` (SIWE). */
export function authorizeSeed(request: Request): boolean {
  const secret = process.env.SEED_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}
