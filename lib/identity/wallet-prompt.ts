/**
 * OAuth without a signing wallet cannot touch Gun.
 * A bound hyperme.sh wallet is Panopticon `GET /auth/siwe/me`
 * (`user_wallet_bindings`). Yes starts SIWE for that address.
 * No wallet, or No, does not mint a key.
 */

export const HYPERMESH_WALLET_PROMPT =
  "You have a USDC wallet with hyperme.sh. You need a wallet for s3r.ch network features. Connect your hyperme.sh wallet now?";

export const WALLET_BEFORE_HOPS =
  "Create or connect a wallet, then sign in, before Gun, Check, payments, TURN, or oracles.";

export const HYPERMESH_WALLET_DECLINE_KEY = "s3rch-hypermesh-wallet";

export type WalletPrompt =
  | { kind: "hypermesh"; copy: string; wallet: string }
  | { kind: "create"; copy: string }
  | { kind: "none" };

export function walletPromptForOAuth(input: {
  hypermeshWallet: string | null;
  declined: boolean;
}): WalletPrompt {
  if (input.hypermeshWallet && !input.declined) {
    return { kind: "hypermesh", copy: HYPERMESH_WALLET_PROMPT, wallet: input.hypermeshWallet };
  }
  if (input.hypermeshWallet && input.declined) return { kind: "none" };
  return { kind: "create", copy: WALLET_BEFORE_HOPS };
}
