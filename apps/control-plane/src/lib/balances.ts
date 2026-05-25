import { createSolanaRpc, address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { base, polygon } from "viem/chains";
import { evm, solana } from "@faremeter/info";
import { logger } from "../logger.js";
import { getSymbolToUsdRate } from "./jupiter-prices.js";

// @solana-program/token-2022 is 4MB for one constant — define inline
const TOKEN_2022_PROGRAM_ADDRESS = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

const USDC_DECIMALS = 6;
const SOLANA_DECIMALS = 9;

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelay?: number; name?: string } = {},
): Promise<T> {
  const { retries = 3, baseDelay = 500, name = "operation" } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt);
        logger.warn(
          `${name} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  throw lastError!;
}

const SOLANA_USDC = solana.lookupKnownSPLToken("mainnet-beta", "USDC");
const BASE_USDC = evm.lookupKnownAsset("base", "USDC");
const POLYGON_USDC = evm.lookupKnownAsset("eip155:137", "USDC");
const MONAD_USDC = evm.lookupKnownAsset("eip155:143", "USDC");

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const solanaRpc = createSolanaRpc(SOLANA_RPC_URL);

const monad = {
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.monad.xyz"] },
  },
} as const;

export interface TokenBalance {
  symbol: string;
  amount: string;
  usdEquivalent?: number;
}

interface ChainBalances {
  native: string;
  usdc: string;
  tokens: TokenBalance[];
}

export interface WalletBalances {
  solana: ChainBalances;
  base: ChainBalances;
  polygon: ChainBalances;
  monad: ChainBalances;
}

// Build a map of known stablecoin mint address -> symbol
const KNOWN_SOLANA_MINTS = new Map<string, string>();
const SOLANA_STABLECOIN_SYMBOLS = [
  "USDT",
  "PYUSD",
  "USDG",
  "USD1",
  "USX",
  "CASH",
  "EURC",
  "JupUSD",
  "USDS",
  "USDtb",
  "USDu",
  "USDGO",
  "FDUSD",
] as const;

for (const symbol of SOLANA_STABLECOIN_SYMBOLS) {
  const info = solana.lookupKnownSPLToken("mainnet-beta", symbol);
  if (info) KNOWN_SOLANA_MINTS.set(info.address, symbol);
}

interface ParsedTokenAccountData {
  parsed?: {
    info?: {
      mint?: string;
      tokenAmount?: { uiAmount?: number; uiAmountString?: string };
    };
  };
}

async function getSolanaBalances(addr: string): Promise<ChainBalances> {
  return withRetry(
    async () => {
      const pubkey = address(addr);

      const balanceResult = await solanaRpc.getBalance(pubkey).send();
      const native = (
        Number(balanceResult.value) /
        10 ** SOLANA_DECIMALS
      ).toFixed(4);

      // Fetch ALL token accounts in 2 calls (SPL Token + Token-2022) instead of per-mint
      const [splAccounts, token2022Accounts] = await Promise.allSettled([
        solanaRpc
          .getTokenAccountsByOwner(
            pubkey,
            { programId: TOKEN_PROGRAM_ADDRESS },
            { encoding: "jsonParsed" },
          )
          .send(),
        solanaRpc
          .getTokenAccountsByOwner(
            pubkey,
            { programId: TOKEN_2022_PROGRAM_ADDRESS },
            { encoding: "jsonParsed" },
          )
          .send(),
      ]);

      // Aggregate balances per mint across all accounts
      const mintBalances = new Map<string, number>();
      const allAccounts = [
        ...(splAccounts.status === "fulfilled" ? splAccounts.value.value : []),
        ...(token2022Accounts.status === "fulfilled"
          ? token2022Accounts.value.value
          : []),
      ];

      for (const account of allAccounts) {
        const data = account.account.data as ParsedTokenAccountData;
        const mint = data.parsed?.info?.mint;
        const amount = data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (mint && amount > 0) {
          mintBalances.set(mint, (mintBalances.get(mint) ?? 0) + amount);
        }
      }

      // Extract USDC balance
      let usdc = "0.00";
      if (SOLANA_USDC) {
        const usdcAmount = mintBalances.get(SOLANA_USDC.address) ?? 0;
        usdc = usdcAmount.toFixed(2);
      }

      // Extract other known stablecoin balances with USD equivalents
      const tokensWithBalance: { symbol: string; amount: number }[] = [];
      for (const [mint, symbol] of KNOWN_SOLANA_MINTS) {
        const amount = mintBalances.get(mint) ?? 0;
        if (amount > 0) {
          tokensWithBalance.push({ symbol, amount });
        }
      }

      let rates: Record<string, number> = {};
      if (tokensWithBalance.length > 0) {
        try {
          rates = await getSymbolToUsdRate();
        } catch {
          // Jupiter rates unavailable - show raw amounts without USD equivalent
        }
      }

      const tokens: TokenBalance[] = tokensWithBalance.map(
        ({ symbol, amount }) => {
          const rate = rates[symbol];
          const tb: TokenBalance = { symbol, amount: amount.toFixed(2) };
          if (rate) tb.usdEquivalent = amount * rate;
          return tb;
        },
      );

      return { native, usdc, tokens };
    },
    { name: `Solana balance fetch (${addr.slice(0, 8)}...)` },
  );
}

async function getEvmBalances(
  addr: string,
  chain: typeof base | typeof polygon | typeof monad,
  usdcAddress?: string,
): Promise<ChainBalances> {
  return withRetry(
    async () => {
      const client = createPublicClient({
        chain,
        transport: http(),
      });

      const nativeBalance = await client.getBalance({
        address: addr as `0x${string}`,
      });
      const native = formatUnits(nativeBalance, 18);

      let usdc = "0";
      if (usdcAddress) {
        try {
          const usdcBalance = await client.readContract({
            address: usdcAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [addr as `0x${string}`],
          });
          usdc = formatUnits(usdcBalance, USDC_DECIMALS);
        } catch {
          // USDC contract call failed - this is OK, USDC balance is 0
        }
      }

      return {
        native: parseFloat(native).toFixed(6),
        usdc: parseFloat(usdc).toFixed(2),
        tokens: [],
      };
    },
    { name: `${chain.name} balance fetch (${addr.slice(0, 8)}...)` },
  );
}

export async function fetchWalletBalances(addresses: {
  solana: string | null;
  evm: string | null;
}): Promise<WalletBalances> {
  const defaults = {
    solana: { native: "0.0000", usdc: "0.00", tokens: [] as TokenBalance[] },
    evm: { native: "0.000000", usdc: "0.00", tokens: [] as TokenBalance[] },
  };

  const chainNames = ["solana", "base", "polygon", "monad"] as const;

  const results = await Promise.allSettled([
    addresses.solana ? getSolanaBalances(addresses.solana) : defaults.solana,
    addresses.evm
      ? getEvmBalances(addresses.evm, base, BASE_USDC?.address)
      : defaults.evm,
    addresses.evm
      ? getEvmBalances(addresses.evm, polygon, POLYGON_USDC?.address)
      : defaults.evm,
    addresses.evm
      ? getEvmBalances(addresses.evm, monad, MONAD_USDC?.address)
      : defaults.evm,
  ]);

  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      logger.error(
        `${chainNames[i]} balance fetch failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }

  return {
    solana:
      results[0].status === "fulfilled" ? results[0].value : defaults.solana,
    base: results[1].status === "fulfilled" ? results[1].value : defaults.evm,
    polygon:
      results[2].status === "fulfilled" ? results[2].value : defaults.evm,
    monad: results[3].status === "fulfilled" ? results[3].value : defaults.evm,
  };
}

export const BALANCE_CACHE_TTL_MS = 60 * 1000; // 1 minute

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

export function extractAddresses(config: WalletConfig | null): {
  solana: string | null;
  evm: string | null;
} {
  if (!config) return { solana: null, evm: null };
  return {
    solana:
      config.solana?.["mainnet-beta"]?.address ??
      config.solana?.devnet?.address ??
      null,
    evm: config.evm?.base?.address ?? null,
  };
}

export function checkBalancesMeetMinimum(
  balances: WalletBalances | null,
  minSol: number,
  minUsdc: number,
): boolean {
  if (!balances) return false;

  if (balances.solana) {
    const sol = parseFloat(balances.solana.native || "0");
    const usdc = parseFloat(balances.solana.usdc || "0");
    if (sol >= minSol && usdc >= minUsdc) return true;
  }

  for (const chain of ["base", "polygon", "monad"] as const) {
    const chainBalances = balances[chain];
    if (chainBalances) {
      const native = parseFloat(chainBalances.native || "0");
      const usdc = parseFloat(chainBalances.usdc || "0");
      if (native > 0 && usdc >= minUsdc) return true;
    }
  }

  return false;
}
