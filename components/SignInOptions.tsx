import { useEffect, useState } from "react";
import { ProviderMark, type Provider } from "@/components/ProviderMark";

const option = "login-option";

export type PublicProvider = { id: string; kind: string; label: string };

type Props = {
  connected: boolean;
  address: string;
  pending: boolean;
  walletConnectAvailable: boolean;
  smartWalletAvailable: boolean;
  accountLabel?: string;
  linked?: boolean;
  walletPrompt?: string;
  useExistingWallet: boolean;
  onConnect: () => void;
  onWalletConnect: () => void;
  onPasskeyWallet: () => void;
  onSignIn: () => void;
  onUseExisting: () => void;
  onDeclineExisting: () => void;
  /** Provider list known up front (tests, server render). Otherwise fetched. */
  providers?: PublicProvider[];
};

type AccountOption = { key: string; mark: Provider; label: string; href: string };

const START = "/api/identity/oauth/start";
const DEFAULT_OIDC_ID = "panopticon";

/** Brokered sign-ins on the default provider, plus one entry per other provider. */
export function accountOptions(providers: readonly PublicProvider[]): AccountOption[] {
  const options: AccountOption[] = [];
  for (const provider of providers) {
    if (provider.kind !== "oidc") continue;
    const base = `${START}?provider=${encodeURIComponent(provider.id)}`;
    if (provider.id === DEFAULT_OIDC_ID) {
      options.push(
        { key: "microsoft", mark: "microsoft", label: "Microsoft", href: `${base}&idp=microsoft` },
        { key: "github", mark: "github", label: "GitHub", href: `${base}&idp=github` },
        { key: "google", mark: "google", label: "Google", href: `${base}&idp=google` },
        { key: provider.id, mark: "hypermesh", label: "Hypermesh", href: base },
      );
    } else {
      options.push({ key: provider.id, mark: "wallet", label: provider.label, href: base });
    }
  }
  return options;
}

function useAccountOptions(initial?: PublicProvider[]): AccountOption[] {
  const [options, setOptions] = useState<AccountOption[]>(() => accountOptions(initial ?? []));
  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch("/api/identity/providers", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { providers: [] }))
      .then((body: { providers?: PublicProvider[] }) => {
        if (!cancelled) setOptions(accountOptions(Array.isArray(body.providers) ? body.providers : []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial]);
  return options;
}

/** Presentation only: wallet signing and account linking stay in IdentityBar. */
export function SignInOptions(props: Props) {
  const accounts = useAccountOptions(props.providers);
  return (
    <div className="w-full">
      <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
        Connect your wallet, then sign a message to continue.
        You can also start with an account you already use.
      </p>
      <div className="login-methods mt-6">
        <section aria-label="Wallet sign-in" className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Use a wallet</h3>
          <p className="mt-1 mb-4 text-xs text-ink-muted">Your identity on s3r.ch</p>
          {props.walletPrompt ? <p role="status" className="mb-4 text-sm text-ink-muted">{props.walletPrompt}</p> : null}
          {props.useExistingWallet ? (
            <div className="grid gap-2">
              <button type="button" className={`${option} login-option-primary`} disabled={props.pending} onClick={props.onUseExisting}>
                <ProviderMark provider="hypermesh" /> Connect Hypermesh wallet
              </button>
              <button type="button" className={option} disabled={props.pending} onClick={props.onDeclineExisting}>Continue without this wallet</button>
            </div>
          ) : props.connected ? (
            <div className="grid gap-3">
              <p role="status" className="text-sm text-ink-muted">Connected <span className="font-data text-ink">{props.address}</span></p>
              <button type="button" className={`${option} login-option-primary`} disabled={props.pending} onClick={props.onSignIn}>
                <ProviderMark provider="wallet" /> {props.pending ? "Check your wallet…" : "Sign in with wallet"}
              </button>
              <p className="text-xs text-ink-muted">Confirm the sign-in message in your wallet.</p>
            </div>
          ) : (
            <div className="grid gap-2">
              <button type="button" className={`${option} login-option-primary`} disabled={props.pending} onClick={props.onConnect}>
                <ProviderMark provider="wallet" /><span>Browser wallet<span className="login-option-detail">Connect your wallet extension</span></span>
              </button>
              {props.walletConnectAvailable ? (
                <button type="button" className={option} disabled={props.pending} onClick={props.onWalletConnect}>
                  <ProviderMark provider="walletconnect" /><span>WalletConnect<span className="login-option-detail">Connect a mobile wallet</span></span>
                </button>
              ) : null}
              {props.smartWalletAvailable ? (
                <button type="button" className={option} disabled={props.pending} onClick={props.onPasskeyWallet}>
                  <ProviderMark provider="coinbase" /><span>Coinbase Smart Wallet<span className="login-option-detail">Continue with a passkey</span></span>
                </button>
              ) : null}
              {props.pending ? <p role="status" className="text-xs text-ink-muted">Check your wallet to continue…</p> : null}
            </div>
          )}
        </section>
        {accounts.length > 0 ? <section aria-label="Account sign-in" className="login-accounts min-w-0">
          <h3 className="text-sm font-semibold text-ink">Use an existing account</h3>
          <p className="mt-1 mb-4 text-xs text-ink-muted">Then link it to your wallet</p>
          <div className="grid gap-2">
            {accounts.map(({ key, mark, label, href }) => (
              <a key={key} href={props.pending ? undefined : href} aria-disabled={props.pending || undefined} className={option}>
                <ProviderMark provider={mark} /><span>Continue with {label}</span>
              </a>
            ))}
          </div>
          {props.accountLabel ? <p className="mt-3 text-xs text-ink-muted" role="status">{props.accountLabel} · {props.linked ? "Wallet linked" : "Wallet not linked yet"}</p> : null}
        </section> : null}
      </div>
    </div>
  );
}
