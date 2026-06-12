export type SupportedSolanaWalletCluster = "mainnet-beta" | "devnet";
export type FaremeterDashSolanaChain = "solana" | "solana-devnet";

export interface WalletConfig {
  solana?: {
    "mainnet-beta"?: { address?: string; key?: string };
    devnet?: { address?: string; key?: string };
  };
  evm?: {
    base?: { address?: string; key?: string };
    polygon?: { address?: string; key?: string };
    monad?: { address?: string; key?: string };
  };
}

export function getConfiguredSolanaCluster(
  rawCluster = process.env.SOLANA_NETWORK,
): SupportedSolanaWalletCluster {
  if (rawCluster === undefined) {
    return "mainnet-beta";
  }
  if (rawCluster === "mainnet-beta" || rawCluster === "devnet") {
    return rawCluster;
  }
  throw new Error(
    `Unsupported SOLANA_NETWORK "${rawCluster}". Expected "devnet" or "mainnet-beta".`,
  );
}

export function getDefaultSolanaRpcUrl(
  cluster = getConfiguredSolanaCluster(),
): string {
  return cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? getDefaultSolanaRpcUrl();
}

export function getFaremeterDashSolanaChain(
  cluster = getConfiguredSolanaCluster(),
): FaremeterDashSolanaChain {
  return cluster === "devnet" ? "solana-devnet" : "solana";
}

export function getSolanaPaymentNetwork(
  cluster = getConfiguredSolanaCluster(),
) {
  return cluster === "devnet" ? "solana-devnet" : "solana-mainnet-beta";
}

export function extractSolanaAddress(
  config: WalletConfig | null,
  preferredCluster = getConfiguredSolanaCluster(),
): string | null {
  if (!config?.solana) return null;
  return config.solana[preferredCluster]?.address ?? null;
}

export function extractAddresses(config: WalletConfig | null): {
  solana: string | null;
  evm: string | null;
} {
  if (!config) return { solana: null, evm: null };
  return {
    solana: extractSolanaAddress(config),
    evm: config.evm?.base?.address ?? null,
  };
}

export function getWalletAddresses(config: WalletConfig | null): {
  solana: string | undefined;
  base: string | undefined;
  polygon: string | undefined;
  monad: string | undefined;
} {
  return {
    solana: extractSolanaAddress(config) ?? undefined,
    base: config?.evm?.base?.address,
    polygon: config?.evm?.polygon?.address,
    monad: config?.evm?.monad?.address,
  };
}
