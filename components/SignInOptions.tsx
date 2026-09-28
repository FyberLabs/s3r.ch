import { ProviderMark, type Provider } from "@/components/ProviderMark";

const option = "login-option";

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
};

const accounts: { provider: Provider; label: string; href: string }[] = [
  { provider: "microsoft", label: "Microsoft", href: "/api/identity/oauth/start?idp=microsoft" },
  { provider: "github", label: "GitHub", href: "/api/identity/oauth/start?idp=github" },
  { provider: "google", label: "Google", href: "/api/identity/oauth/start?idp=google" },
  { provider: "hypermesh", label: "Hypermesh", href: "/api/identity/oauth/start" },
];

/** Presentation only: wallet signing and account linking stay in IdentityBar. */
export function SignInOptions(props: Props) {
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
        <section aria-label="Account sign-in" className="login-accounts min-w-0">
          <h3 className="text-sm font-semibold text-ink">Use an existing account</h3>
          <p className="mt-1 mb-4 text-xs text-ink-muted">Continue through your Hypermesh account</p>
          <div className="grid gap-2">
            {accounts.map(({ provider, label, href }) => (
              <a key={provider} href={props.pending ? undefined : href} aria-disabled={props.pending || undefined} className={option}>
                <ProviderMark provider={provider} /><span>Continue with {label}</span>
              </a>
            ))}
          </div>
          {props.accountLabel ? <p className="mt-3 text-xs text-ink-muted" role="status">{props.accountLabel} · {props.linked ? "Wallet linked" : "Wallet not linked yet"}</p> : null}
        </section>
      </div>
    </div>
  );
}
