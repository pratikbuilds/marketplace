import "../tests/setup/env.js";
import t from "tap";
import { type } from "arktype";
import { Hono } from "hono";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { signToken } from "../middleware/auth.js";
import { tokenPricesRoutes } from "./token-prices.js";

const TokenPriceResponse = type({
  token_symbol: "string",
  "mint_address?": "string",
  "network?": "string",
  "endpoint_id?": "number | null",
  "amount?": "number",
  "decimals?": "number",
  "payout_splits?": "unknown",
  "+": "delete",
});

const TokenPriceListResponse = type({
  data: TokenPriceResponse.array(),
  "+": "delete",
});

const ErrorResponse = type({
  "error?": "string",
  "+": "delete",
});

const app = new Hono();
app.route("/api/tenants/:tenantId/token-prices", tokenPricesRoutes);

await setupTestSchema();

interface TestUser {
  id: number;
  token: string;
}

async function createUser(email: string, isAdmin = false): Promise<TestUser> {
  const user = await db
    .insertInto("users")
    .values({
      email,
      password_hash: "hash",
      is_admin: isAdmin,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  const token = signToken({ userId: user.id, email: user.email, isAdmin });
  return { id: user.id, token };
}

async function createOrg(name: string, slug: string) {
  return db
    .insertInto("organizations")
    .values({ name, slug })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function addMember(userId: number, orgId: number, role = "member") {
  await db
    .insertInto("user_organizations")
    .values({ user_id: userId, organization_id: orgId, role })
    .execute();
}

async function createTenant(orgId: number, name: string) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: "http://backend.example.com",
      default_price: 1000,
      default_scheme: "exact",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createEndpoint(tenantId: number, path: string) {
  return db
    .insertInto("endpoints")
    .values({
      tenant_id: tenantId,
      path,
      path_pattern: path,
      priority: 100,
      price: 500,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTokenPrice(
  tenantId: number,
  opts: {
    endpointId?: number | null;
    symbol?: string;
    mint?: string;
    network?: string;
    amount?: number;
    payoutSplits?: { recipient: string; bps: number }[];
  } = {},
) {
  return db
    .insertInto("token_prices")
    .values({
      tenant_id: tenantId,
      endpoint_id: opts.endpointId ?? null,
      token_symbol: opts.symbol ?? "USDC",
      mint_address: opts.mint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      network: opts.network ?? "solana-mainnet-beta",
      amount: opts.amount ?? 1000,
      decimals: 6,
      payout_splits: opts.payoutSplits
        ? JSON.stringify(opts.payoutSplits)
        : undefined,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("Auth & access control", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/tenants/1/token-prices");
    t.equal(res.status, 401);
  });

  await t.test("returns 403 for non-member", async (t) => {
    const user = await createUser("outsider@example.com");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 403);
  });

  await t.test("returns 200 for org member", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
  });

  await t.test("returns 200 for admin without membership", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
  });
});

await t.test("GET / (list)", async (t) => {
  await t.test("returns empty list when no token_prices exist", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = TokenPriceListResponse.assert(await res.json());
    t.equal(data.data.length, 0);
  });

  await t.test("returns tenant-level prices by default", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const endpoint = await createEndpoint(tenant.id, "/api/test");

    await createTokenPrice(tenant.id, { symbol: "USDC" });
    await createTokenPrice(tenant.id, {
      symbol: "USDT",
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    });
    await createTokenPrice(tenant.id, {
      endpointId: endpoint.id,
      symbol: "PYUSD",
      mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    });

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    const data = TokenPriceListResponse.assert(await res.json());
    t.equal(data.data.length, 2);
    if (!data.data[0]) throw new Error("expected data.data[0]");
    t.equal(data.data[0].token_symbol, "USDC");
    if (!data.data[1]) throw new Error("expected data.data[1]");
    t.equal(data.data[1].token_symbol, "USDT");
  });

  await t.test("returns endpoint-level prices with query param", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const endpoint = await createEndpoint(tenant.id, "/api/test");

    await createTokenPrice(tenant.id, { symbol: "USDC" });
    await createTokenPrice(tenant.id, {
      endpointId: endpoint.id,
      symbol: "PYUSD",
      mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices?endpoint_id=${endpoint.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    const data = TokenPriceListResponse.assert(await res.json());
    t.equal(data.data.length, 1);
    if (!data.data[0]) throw new Error("expected data.data[0]");
    t.equal(data.data[0].token_symbol, "PYUSD");
  });
});

await t.test("GET /:id", async (t) => {
  await t.test("returns single token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id, {
      symbol: "USDT",
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      amount: 5000,
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 200);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.token_symbol, "USDT");
  });

  await t.test("returns 404 for non-existent id", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/99999`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 404);
  });

  await t.test("returns 404 for id in different tenant", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant1 = await createTenant(org.id, "proxy-1");
    const tenant2 = await createTenant(org.id, "proxy-2");
    const tp = await createTokenPrice(tenant2.id);

    const res = await app.request(
      `/api/tenants/${tenant1.id}/token-prices/${tp.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 404);
  });
});

await t.test("POST / (create)", async (t) => {
  await t.test("creates tenant-level token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        amount: 1000,
      }),
    });
    t.equal(res.status, 201);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.token_symbol, "USDT");
    t.equal(data.endpoint_id, null);
  });

  await t.test("creates solana devnet token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDC",
        mint_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        network: "solana-devnet",
        amount: 1000,
      }),
    });
    t.equal(res.status, 201);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.token_symbol, "USDC");
    t.equal(data.network, "solana-devnet");
    t.equal(data.mint_address, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  await t.test("creates endpoint-level token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const endpoint = await createEndpoint(tenant.id, "/api/test");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        amount: 500,
        endpoint_id: endpoint.id,
      }),
    });
    t.equal(res.status, 201);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.endpoint_id, endpoint.id);
  });

  await t.test("creates token price with payout splits", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDC",
        mint_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        network: "solana-devnet",
        amount: 1000,
        payout_splits: [
          { recipient: "ReceiverA", bps: 6500 },
          { recipient: "ReceiverB", bps: 3500 },
        ],
      }),
    });
    t.equal(res.status, 201);
    const data = TokenPriceResponse.assert(await res.json());
    t.matchOnly(data.payout_splits, [
      { recipient: "ReceiverA", bps: 6500 },
      { recipient: "ReceiverB", bps: 3500 },
    ]);
  });

  await t.test("rejects payout splits that do not sum to 10000", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDC",
        mint_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        network: "solana-devnet",
        amount: 1000,
        payout_splits: [{ recipient: "ReceiverA", bps: 9000 }],
      }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.match(data.error, /sum to 10000/);
  });

  await t.test("returns 400 for missing required fields", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token_symbol: "USDT" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("returns 400 for invalid network", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "invalid-network",
        amount: 1000,
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test("returns 400 for non-integer amount", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        amount: 1.5,
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test(
    "returns 400 for endpoint not belonging to tenant",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant1 = await createTenant(org.id, "proxy-1");
      const tenant2 = await createTenant(org.id, "proxy-2");
      const endpoint = await createEndpoint(tenant2.id, "/api/other");

      const res = await app.request(`/api/tenants/${tenant1.id}/token-prices`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token_symbol: "USDT",
          mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          network: "solana-mainnet-beta",
          amount: 1000,
          endpoint_id: endpoint.id,
        }),
      });
      t.equal(res.status, 400);
    },
  );

  await t.test("returns 409 for duplicate token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    await createTokenPrice(tenant.id, {
      symbol: "USDT",
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    });

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        amount: 2000,
      }),
    });
    t.equal(res.status, 409);
  });

  await t.test("allows same token on different networks", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    await createTokenPrice(tenant.id, {
      symbol: "USDC",
      network: "solana-mainnet-beta",
    });

    const res = await app.request(`/api/tenants/${tenant.id}/token-prices`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: "USDC",
        mint_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        network: "base",
        amount: 1000,
      }),
    });
    t.equal(res.status, 201);
  });
});

await t.test("PUT /:id (update)", async (t) => {
  await t.test("updates amount", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id, { amount: 1000 });

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: 5000 }),
      },
    );
    t.equal(res.status, 200);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.amount, 5000);
  });

  await t.test("updates decimals", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id);

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decimals: 8 }),
      },
    );
    t.equal(res.status, 200);
    const data = TokenPriceResponse.assert(await res.json());
    t.equal(data.decimals, 8);
  });

  await t.test("updates payout splits", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id);

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payout_splits: [
            { recipient: "ReceiverA", bps: 5000 },
            { recipient: "ReceiverB", bps: 5000 },
          ],
        }),
      },
    );
    t.equal(res.status, 200);
    const data = TokenPriceResponse.assert(await res.json());
    t.matchOnly(data.payout_splits, [
      { recipient: "ReceiverA", bps: 5000 },
      { recipient: "ReceiverB", bps: 5000 },
    ]);
  });

  await t.test("returns 400 for empty body", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id);

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("returns 404 for non-existent id", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/99999`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: 5000 }),
      },
    );
    t.equal(res.status, 404);
  });

  await t.test("returns 404 for id in different tenant", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant1 = await createTenant(org.id, "proxy-1");
    const tenant2 = await createTenant(org.id, "proxy-2");
    const tp = await createTokenPrice(tenant2.id);

    const res = await app.request(
      `/api/tenants/${tenant1.id}/token-prices/${tp.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: 5000 }),
      },
    );
    t.equal(res.status, 404);
  });
});

await t.test("DELETE /:id", async (t) => {
  await t.test("deletes token price", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");
    const tp = await createTokenPrice(tenant.id);

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );
    t.equal(res.status, 200);

    // Verify it's gone
    const check = await app.request(
      `/api/tenants/${tenant.id}/token-prices/${tp.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(check.status, 404);
  });

  await t.test("returns 404 for non-existent id", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-proxy");

    const res = await app.request(
      `/api/tenants/${tenant.id}/token-prices/99999`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );
    t.equal(res.status, 404);
  });

  await t.test("returns 404 for id in different tenant", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant1 = await createTenant(org.id, "proxy-1");
    const tenant2 = await createTenant(org.id, "proxy-2");
    const tp = await createTokenPrice(tenant2.id);

    const res = await app.request(
      `/api/tenants/${tenant1.id}/token-prices/${tp.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );
    t.equal(res.status, 404);
  });
});
