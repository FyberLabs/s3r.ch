import { http, createConfig, type CreateConnectorFn } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  sepolia,
} from "wagmi/chains";

const CHAINS = [mainnet, sepolia, base, optimism, arbitrum, polygon] as const;

/**
 * Reown Cloud / WalletConnect project id from the Next.js public env.
 * Trimmed; empty or unset → null (no WalletConnect). Do not invent an id.
 * Injected + Coinbase Smart Wallet stay present either way.
 */
export function walletConnectProjectId(
  raw: string | undefined = process.env.NEXT_PUBLIC_WC_PROJECT_ID,
): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

const WALLETCONNECT_METADATA = {
  name: "s3r.ch",
  description: "s3r.ch",
  url: "https://s3r.ch",
  icons: ["https://s3r.ch/favicon.ico"],
};

/**
 * Passkey / Smart Wallet onramp. Ungated — no Coinbase CDP project id.
 * Smart Wallet only (not the extension EOA). After connect, SIWE is unchanged.
 */
export function coinbaseSmartWalletConnector(): CreateConnectorFn {
  return coinbaseWallet({
    appName: "s3r.ch",
    appLogoUrl: "https://s3r.ch/favicon.ico",
    preference: { options: "smartWalletOnly" },
  });
}

/**
 * Injected and Coinbase Smart Wallet are always present. walletConnect is
 * added only when a project id is present. No RainbowKit / ConnectKit /
 * CDP Embedded Wallet.
 */
export function identityConnectors(
  projectId: string | null = walletConnectProjectId(),
): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [
    injected(),
    coinbaseSmartWalletConnector(),
  ];
  if (projectId) {
    connectors.push(
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: WALLETCONNECT_METADATA,
      }),
    );
  }
  return connectors;
}

export const wagmiConfig = createConfig({
  chains: CHAINS,
  connectors: identityConnectors(),
  ssr: true,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [base.id]: http(),
    [optimism.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
  },
});
