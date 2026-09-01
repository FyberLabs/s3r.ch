import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  sepolia,
} from "wagmi/chains";

/**
 * Injected connector only. WalletConnect needs NEXT_PUBLIC_WC_PROJECT_ID
 * (we do not have one; do not add it to CI). No RainbowKit / ConnectKit.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia, base, optimism, arbitrum, polygon],
  connectors: [injected()],
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
