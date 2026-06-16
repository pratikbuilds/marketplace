import "../tests/setup/env.js";
import t from "tap";
import { Hono } from "hono";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { tokenRatesRoutes } from "./token-rates.js";
import { seedTokenPricesForTenant } from "../lib/token-seed.js";
import type { SupportedToken } from "../db/schema.js";

const originalSolanaNetwork = process.env.SOLANA_NETWORK;

const app = new Hono();
app.route("/api/token-rates", tokenRatesRoutes);

await setupTestSchema();

t.teardown(() => {
  if (originalSolanaNetwork === undefined) {
    delete process.env.SOLANA_NETWORK;
  } else {
    process.env.SOLANA_NETWORK = originalSolanaNetwork;
  }
});

// supported_tokens is seeded by setupTestSchema — re-seed if a test clears it
async function reseedSupportedTokens() {
  await db.deleteFrom("supported_tokens").execute();
  await db
    .insertInto("supported_tokens")
    .values([
      {
        symbol: "USDC",
        mint_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        network: "solana-mainnet-beta",
        is_usd_pegged: true,
      },
      {
        symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        is_usd_pegged: true,
      },
      {
        symbol: "EURC",
        mint_address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        network: "solana-mainnet-beta",
        is_usd_pegged: false,
      },
      {
        symbol: "USDC",
        mint_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        network: "base",
        is_usd_pegged: true,
      },
    ])
    .execute();
}

await t.test("GET /api/token-rates/supported-tokens", async (t) => {
  t.beforeEach(async () => {
    await clearTestData();
  });

  await t.test("returns all supported tokens", async (t) => {
    const res = await app.request("/api/token-rates/supported-tokens");
    t.equal(res.status, 200);
    const body = (await res.json()) as { data: SupportedToken[] };
    t.equal(body.data.length, 4);
    t.ok(body.data.find((t: { symbol: string }) => t.symbol === "USDC"));
    t.ok(body.data.find((t: { symbol: string }) => t.symbol === "USDT"));
    t.ok(body.data.find((t: { symbol: string }) => t.symbol === "EURC"));
  });

  await t.test("returns correct shape", async (t) => {
    const res = await app.request("/api/token-rates/supported-tokens");
    const body = (await res.json()) as { data: SupportedToken[] };
    const [usdc] = body.data.filter(
      (tok) => tok.symbol === "USDC" && tok.network === "solana-mainnet-beta",
    );
    t.ok(usdc, "USDC solana entry exists");
    t.equal(usdc?.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    t.equal(usdc?.network, "solana-mainnet-beta");
    t.equal(usdc?.isUsdPegged, true);
  });

  await t.test("returns isUsdPegged=false for non-USD tokens", async (t) => {
    const res = await app.request("/api/token-rates/supported-tokens");
    const body = (await res.json()) as { data: SupportedToken[] };
    const [eurc] = body.data.filter((tok) => tok.symbol === "EURC");
    t.ok(eurc, "EURC entry exists");
    t.equal(eurc?.isUsdPegged, false);
  });

  await t.test("returns empty when no tokens seeded", async (t) => {
    await db.deleteFrom("supported_tokens").execute();
    const res = await app.request("/api/token-rates/supported-tokens");
    const body = (await res.json()) as { data: SupportedToken[] };
    t.equal(body.data.length, 0);
    await reseedSupportedTokens();
  });
});

await t.test("seedTokenPricesForTenant", async (t) => {
  t.beforeEach(async () => {
    await clearTestData();
  });

  await t.test(
    "seeds only USD-pegged tokens from supported_tokens table",
    async (t) => {
      const org = await db
        .insertInto("organizations")
        .values({ name: "test-org", slug: "test-org" })
        .returning("id")
        .executeTakeFirstOrThrow();

      const wallet = await db
        .insertInto("wallets")
        .values({
          organization_id: org.id,
          name: "test",
          wallet_config: "{}",
          funding_status: "funded",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "test-tenant",
          backend_url: "https://example.com",
          organization_id: org.id,
          wallet_id: wallet.id,
          default_price: 10000,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await seedTokenPricesForTenant(db, tenant.id, 10000);

      const prices = await db
        .selectFrom("token_prices")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .execute();

      // Should seed 3 USD-pegged tokens (USDC solana, USDT solana, USDC base)
      // EURC is not USD-pegged so should be excluded
      t.equal(prices.length, 3);
      const symbols = prices.map((p) => `${p.token_symbol}:${p.network}`);
      t.ok(symbols.includes("USDC:solana-mainnet-beta"));
      t.ok(symbols.includes("USDT:solana-mainnet-beta"));
      t.ok(symbols.includes("USDC:base"));
      t.notOk(symbols.includes("EURC:solana-mainnet-beta"));
    },
  );

  await t.test(
    "seeds only the configured Solana network from supported_tokens",
    async (t) => {
      t.teardown(() => {
        if (originalSolanaNetwork === undefined) {
          delete process.env.SOLANA_NETWORK;
        } else {
          process.env.SOLANA_NETWORK = originalSolanaNetwork;
        }
      });

      process.env.SOLANA_NETWORK = "devnet";
      await db
        .insertInto("supported_tokens")
        .values({
          symbol: "USDC",
          mint_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          network: "solana-devnet",
          is_usd_pegged: true,
        })
        .execute();

      const org = await db
        .insertInto("organizations")
        .values({ name: "test-org-devnet", slug: "test-org-devnet" })
        .returning("id")
        .executeTakeFirstOrThrow();

      const wallet = await db
        .insertInto("wallets")
        .values({
          organization_id: org.id,
          name: "test",
          wallet_config: "{}",
          funding_status: "funded",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "test-tenant-devnet",
          backend_url: "https://example.com",
          organization_id: org.id,
          wallet_id: wallet.id,
          default_price: 10000,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await seedTokenPricesForTenant(db, tenant.id, 10000);

      const prices = await db
        .selectFrom("token_prices")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .execute();

      const symbols = prices.map((p) => `${p.token_symbol}:${p.network}`);
      t.ok(symbols.includes("USDC:solana-devnet"));
      t.ok(symbols.includes("USDC:base"));
      t.notOk(symbols.includes("USDC:solana-mainnet-beta"));
      t.notOk(symbols.includes("USDT:solana-mainnet-beta"));
    },
  );

  await t.test("does not seed when amount is 0", async (t) => {
    const org = await db
      .insertInto("organizations")
      .values({ name: "test-org2", slug: "test-org2" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const wallet = await db
      .insertInto("wallets")
      .values({
        organization_id: org.id,
        name: "test",
        wallet_config: "{}",
        funding_status: "funded",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant2",
        backend_url: "https://example.com",
        organization_id: org.id,
        wallet_id: wallet.id,
        default_price: 0,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await seedTokenPricesForTenant(db, tenant.id, 0);

    const prices = await db
      .selectFrom("token_prices")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .execute();

    t.equal(prices.length, 0);
  });

  await t.test("does not seed when no supported tokens exist", async (t) => {
    await db.deleteFrom("supported_tokens").execute();

    const org = await db
      .insertInto("organizations")
      .values({ name: "test-org3", slug: "test-org3" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const wallet = await db
      .insertInto("wallets")
      .values({
        organization_id: org.id,
        name: "test",
        wallet_config: "{}",
        funding_status: "funded",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant3",
        backend_url: "https://example.com",
        organization_id: org.id,
        wallet_id: wallet.id,
        default_price: 10000,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await seedTokenPricesForTenant(db, tenant.id, 10000);

    const prices = await db
      .selectFrom("token_prices")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .execute();

    t.equal(prices.length, 0);
    await reseedSupportedTokens();
  });
});
