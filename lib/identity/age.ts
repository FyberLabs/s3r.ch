/**
 * First sign-in must record that the person is at least 18.
 * The time lives on the same identity document as account links.
 * A returning record is not asked again. No session token is minted without it.
 */

import { getLinks } from "./link";
import { signSessionToken } from "./session";

export const AGE_CONFIRMATION_REQUIRED = "age-confirmation-required";

export async function completeWalletSignIn(input: {
  address: string;
  chainId: number;
  ageConfirmed: boolean;
  secret: string;
  oauthSub?: string | null;
  now?: Date;
}): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; token: string; owner: string; confirmedAt: string }
> {
  const links = getLinks();
  const status = links.ageStatusForWallet(input.address, input.oauthSub);
  if ("unavailable" in status) {
    return { ok: false, status: 503, error: "Identity store unavailable" };
  }
  const now = input.now ?? new Date();
  const stamp = "confirmedAt" in status ? status.confirmedAt : input.ageConfirmed ? now.toISOString() : null;
  if (!stamp) return { ok: false, status: 403, error: AGE_CONFIRMATION_REQUIRED };
  const saved = links.saveWalletAge(input.address, stamp, input.oauthSub);
  if ("denied" in saved) {
    const statusCode = saved.reason === "store-unreadable" ? 503 : 400;
    const error = saved.reason === "store-unreadable" ? "Identity store unavailable" : "bad-handle";
    return { ok: false, status: statusCode, error };
  }
  const token = await signSessionToken(
    { address: input.address, chainId: input.chainId },
    input.secret,
    now.getTime(),
  );
  return { ok: true, token, owner: saved.owner, confirmedAt: saved.confirmedAt };
}
