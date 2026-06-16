import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
} from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import bs58 from "bs58";

export interface WalletConfig {
  solana?: {
    "mainnet-beta"?: {
      address: string;
      key?: string;
    };
    devnet?: {
      address: string;
      key?: string;
    };
  };
  evm?: {
    base?: { key?: string; address: string };
    polygon?: { key?: string; address: string };
    monad?: { key?: string; address: string };
  };
}

export interface EcosystemConfig {
  solana: { mode: "generate" | "import" | "skip"; key?: string };
  evm: { mode: "generate" | "import" | "skip"; key?: string };
}

export type SupportedSolanaWalletCluster = "mainnet-beta" | "devnet";

export function getConfiguredSolanaCluster(): SupportedSolanaWalletCluster {
  const rawCluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (rawCluster === undefined) {
    return "mainnet-beta";
  }
  if (rawCluster === "mainnet-beta" || rawCluster === "devnet") {
    return rawCluster;
  }
  throw new Error(
    `Unsupported NEXT_PUBLIC_SOLANA_NETWORK "${rawCluster}". Expected "devnet" or "mainnet-beta".`,
  );
}

export function extractSolanaAddress(
  config: WalletConfig | null,
  preferredCluster = getConfiguredSolanaCluster(),
): string | null {
  if (!config?.solana) return null;
  return config.solana[preferredCluster]?.address ?? null;
}

export async function generateSolanaWallet(): Promise<{
  address: string;
  key: string;
}> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const pubBytes = bs58.decode(signer.address);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed);
  secretKey.set(pubBytes, 32);
  return {
    address: signer.address,
    key: "[" + secretKey.toString() + "]",
  };
}

export function generateEvmWallet(): { address: string; key: string } {
  const privateKey = generatePrivateKey();
  return {
    key: privateKey,
    address: privateKeyToAccount(privateKey).address,
  };
}

export async function deriveSolanaAddress(
  privateKey: string,
): Promise<{ address: string; key: string } | null> {
  try {
    let secretKey: Uint8Array;

    // Try parsing as JSON array first (e.g., "[1,2,3,...]")
    const trimmed = privateKey.trim();
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return null;
      }
      // Validate all values are valid bytes (0-255)
      for (const val of parsed) {
        if (
          typeof val !== "number" ||
          val < 0 ||
          val > 255 ||
          !Number.isInteger(val)
        ) {
          return null;
        }
      }
      secretKey = new Uint8Array(parsed);
    } else {
      // Try base58 decoding
      secretKey = bs58.decode(trimmed);
    }

    if (secretKey.length !== 64) {
      return null;
    }

    const signer = await createKeyPairSignerFromBytes(secretKey);
    return {
      address: signer.address,
      key: "[" + secretKey.toString() + "]",
    };
  } catch {
    return null;
  }
}

export function deriveEvmAddress(
  privateKey: string,
): { address: string; key: string } | null {
  try {
    let key = privateKey.trim();
    if (!key.startsWith("0x")) {
      key = "0x" + key;
    }

    // Validate hex format (0x + 64 hex chars)
    if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
      return null;
    }

    const account = privateKeyToAccount(key as `0x${string}`);
    return {
      key: key,
      address: account.address,
    };
  } catch {
    return null;
  }
}

export async function buildWalletConfig(
  config: EcosystemConfig,
): Promise<WalletConfig> {
  const result: WalletConfig = {};
  const solanaCluster = getConfiguredSolanaCluster();

  // Handle Solana
  if (config.solana.mode === "generate") {
    const wallet = await generateSolanaWallet();
    result.solana = { [solanaCluster]: wallet };
  } else if (config.solana.mode === "import" && config.solana.key) {
    const wallet = await deriveSolanaAddress(config.solana.key);
    if (wallet) {
      result.solana = { [solanaCluster]: wallet };
    }
  }

  // Handle EVM
  if (config.evm.mode === "generate") {
    const wallet = generateEvmWallet();
    result.evm = { base: wallet, polygon: wallet, monad: wallet };
  } else if (config.evm.mode === "import" && config.evm.key) {
    const wallet = deriveEvmAddress(config.evm.key);
    if (wallet) {
      result.evm = { base: wallet, polygon: wallet, monad: wallet };
    }
  }

  return result;
}

export function getWalletAddresses(config: WalletConfig) {
  return {
    solana: extractSolanaAddress(config),
    base: config.evm?.base?.address ?? null,
    polygon: config.evm?.polygon?.address ?? null,
    monad: config.evm?.monad?.address ?? null,
  };
}

export function isValidSolanaAddress(address: string): boolean {
  if (!address) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
}

export function isValidEvmAddress(address: string): boolean {
  if (!address) return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

export function buildAddressOnlyConfig(addresses: {
  solana?: string;
  evm?: string;
}): WalletConfig {
  const result: WalletConfig = {};
  if (addresses.solana) {
    result.solana = {
      [getConfiguredSolanaCluster()]: { address: addresses.solana.trim() },
    };
  }
  if (addresses.evm) {
    const entry = { address: addresses.evm.trim() };
    result.evm = { base: entry, polygon: entry, monad: entry };
  }
  return result;
}

export function hasSolanaAddress(config: WalletConfig): boolean {
  return !!extractSolanaAddress(config);
}

export function isWalletUsable(
  config: WalletConfig,
  fundingStatus: string,
): boolean {
  if (hasSolanaAddress(config)) {
    return fundingStatus === "funded";
  }
  return true;
}
