export type Provider = "microsoft" | "github" | "google" | "hypermesh" | "wallet" | "walletconnect" | "coinbase";

/** Decorative provider marks; the adjacent text supplies the accessible name. */
export function ProviderMark({ provider }: { provider: Provider }) {
  return (
    <span className={`login-provider-mark login-provider-${provider}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" focusable="false">
        {provider === "microsoft" ? <><path fill="#f25022" d="M2 2h9v9H2z"/><path fill="#7fba00" d="M13 2h9v9h-9z"/><path fill="#00a4ef" d="M2 13h9v9H2z"/><path fill="#ffb900" d="M13 13h9v9h-9z"/></> : null}
        {provider === "google" ? <><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#ea4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59C7.19 7.72 9.4 5.96 12 5.96Z"/></> : null}
        {provider === "github" ? <path fill="currentColor" d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.12.68-3.78-1.33-3.78-1.33-.51-1.29-1.24-1.63-1.24-1.63-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.49-.28-5.11-1.24-5.11-5.54 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.99 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.56.23 2.71.11 2.99.72.79 1.16 1.79 1.16 3.02 0 4.31-2.63 5.26-5.13 5.54.4.35.76 1.03.76 2.08v3.07c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/> : null}
        {provider === "coinbase" ? <><circle cx="12" cy="12" r="11" fill="#0052ff"/><circle cx="12" cy="12" r="7" fill="white"/><path fill="#0052ff" d="M9 9h6v6H9z"/></> : null}
        {provider === "walletconnect" ? <path stroke="#3b99fc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d="M3 8a13 13 0 0 1 18 0M2 12l5 5 5-5 5 5 5-5M7 8a7 7 0 0 1 10 0"/> : null}
        {provider === "wallet" ? <g stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M20 8H5a2 2 0 0 1 0-4h13v4M4 6v13a1 1 0 0 0 1 1h15V8"/><path d="M20 12h-5v4h5"/></g> : null}
        {provider === "hypermesh" ? <path fill="currentColor" d="M5 5h14v14H5z"/> : null}
      </svg>
    </span>
  );
}
