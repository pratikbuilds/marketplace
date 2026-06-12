import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { getSolanaPaymentNetwork } from "./solana-wallet.js";

const SOLANA_NETWORKS = new Set(["solana-mainnet-beta", "solana-devnet"]);

type SupportedTokenSeed = {
  symbol: string;
  mint_address: string;
  network: string;
};

function shouldSeedSupportedToken(token: SupportedTokenSeed): boolean {
  if (!SOLANA_NETWORKS.has(token.network)) {
    return true;
  }

  return token.network === getSolanaPaymentNetwork();
}

export async function seedTokenPricesForTenant(
  db: Kysely<Database>,
  tenantId: number,
  amount: number,
  endpointId?: number | null,
): Promise<void> {
  if (amount <= 0) return;

  const tokens = await db
    .selectFrom("supported_tokens")
    .select(["symbol", "mint_address", "network"])
    .where("is_usd_pegged", "=", true)
    .execute();

  const seedTokens = tokens.filter(shouldSeedSupportedToken);

  if (seedTokens.length === 0) return;

  const values = seedTokens.map((t) => ({
    tenant_id: tenantId,
    endpoint_id: endpointId ?? null,
    token_symbol: t.symbol,
    mint_address: t.mint_address,
    network: t.network,
    amount,
    decimals: 6,
  }));

  await db.insertInto("token_prices").values(values).execute();
}

export async function getUsdPeggedSymbols(
  db: Kysely<Database>,
): Promise<string[]> {
  const rows = await db
    .selectFrom("supported_tokens")
    .select("symbol")
    .where("is_usd_pegged", "=", true)
    .execute();

  return [...new Set(rows.map((r) => r.symbol))];
}
