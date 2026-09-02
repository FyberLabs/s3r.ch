import { http, createConfig, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
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
 * Trimmed; empty or unset → null (injected-only). Do not invent an id.
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
 * Injected is always present. walletConnect is added only when a project id
 * is present. No RainbowKit / ConnectKit.
 */
export function identityConnectors(
  projectId: string | null = walletConnectProjectId(),
): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [injected()];
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
