import "../tests/setup/env.js";
import t from "tap";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { buildTenantGatewaySpec } from "./gateway-spec-builder.js";

await setupTestSchema();

async function createOrg(name: string, slug: string) {
  return db
    .insertInto("organizations")
    .values({ name, slug })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createWallet(
  orgId: number,
  config: Record<string, unknown>,
  funded = true,
) {
  return db
    .insertInto("wallets")
    .values({
      name: "test-wallet",
      organization_id: orgId,
      funding_status: funded ? "funded" : "pending",
      wallet_config: JSON.stringify(config),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTenant(
  orgId: number,
  name: string,
  walletId: number | null,
  opts: { defaultScheme?: string; openapiSpec?: Record<string, unknown> } = {},
) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: "http://backend.example.test",
      default_price: 0.01,
      default_scheme: opts.defaultScheme ?? "exact",
      openapi_spec: opts.openapiSpec
        ? JSON.stringify(opts.openapiSpec)
        : undefined,
      wallet_id: walletId,
      status: "active",
      is_active: true,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createEndpoint(
  tenantId: number,
  path: string,
  opts: {
    price?: number | null;
    scheme?: string | null;
    priority?: number;
    openapi_source_paths?: string[];
    description?: string;
    http_method?: string;
  } = {},
) {
  return db
    .insertInto("endpoints")
    .values({
      tenant_id: tenantId,
      path,
      path_pattern: path,
      price: opts.price ?? null,
      scheme: opts.scheme === undefined ? "exact" : opts.scheme,
      priority: opts.priority ?? 100,
      is_active: true,
      openapi_source_paths: opts.openapi_source_paths ?? undefined,
      description: opts.description ?? null,
      http_method: opts.http_method ?? "ANY",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTokenPrice(
  tenantId: number,
  endpointId: number | null,
  opts: {
    symbol?: string;
    mint?: string;
    network?: string;
    amount?: number;
    decimals?: number;
    payoutSplits?: { recipient: string; bps: number }[];
  } = {},
) {
  return db
    .insertInto("token_prices")
    .values({
      tenant_id: tenantId,
      endpoint_id: endpointId,
      token_symbol: opts.symbol ?? "USDC",
      mint_address: opts.mint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      network: opts.network ?? "solana-mainnet-beta",
      amount: opts.amount ?? 1000,
      decimals: opts.decimals ?? 6,
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

await t.test("returns null for nonexistent tenant", async (t) => {
  const result = await buildTenantGatewaySpec(999);
  t.equal(result, null);
});

await t.test("returns null when tenant has no wallet", async (t) => {
  const org = await createOrg("Team", "team");
  const tenant = await createTenant(org.id, "no-wallet", null);
  const result = await buildTenantGatewaySpec(tenant.id);
  t.equal(result, null);
});

await t.test("returns null for invalid wallet_config", async (t) => {
  const org = await createOrg("Team", "team");
  // Insert wallet with a config that violates the arktype schema
  const wallet = await db
    .insertInto("wallets")
    .values({
      name: "bad-wallet",
      organization_id: org.id,
      funding_status: "funded",
      wallet_config: JSON.stringify("not-an-object"),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  const tenant = await createTenant(org.id, "bad-config", wallet.id);
  const result = await buildTenantGatewaySpec(tenant.id);
  t.equal(result, null);
});

await t.test("builds spec with correct structure", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLwALLeTaDdReSs123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "my-api", wallet.id);

  await createEndpoint(tenant.id, "/users/{id}", {
    price: 5000,
    scheme: "exact",
    description: "Get user by ID",
  });

  await createTokenPrice(tenant.id, null, {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    network: "solana-mainnet-beta",
    amount: 1000,
    decimals: 6,
  });

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const spec = result.spec;
  t.equal(spec.openapi, "3.0.3");
  t.same((spec.info as Record<string, unknown>).title, "my-api");

  const assets = spec["x-faremeter-assets"] as Record<string, unknown>;
  t.ok(assets["solana-mainnet-beta-USDC"]);
  const asset = assets["solana-mainnet-beta-USDC"] as Record<string, unknown>;
  t.equal(asset.chain, "solana-mainnet-beta");
  t.equal(asset.token, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  t.equal(asset.decimals, 6);
  t.equal(asset.recipient, "SoLwALLeTaDdReSs123");

  const paths = spec.paths as Record<string, unknown>;
  t.ok(paths["/users/{id}"]);

  const pathEntry = paths["/users/{id}"] as Record<string, unknown>;
  const getOp = pathEntry.get as Record<string, unknown>;
  const pricing = getOp["x-faremeter-pricing"] as Record<string, unknown>;
  t.ok(pricing);
  const rules = pricing.rules as Record<string, unknown>[];
  t.equal(rules.length, 1);
  const rule0 = rules[0];
  t.ok(rule0);
  if (!rule0) return;
  // price=5000 * tenant-level amount=1000 = 5000000
  t.equal(rule0.capture, "5000000");
});

await t.test(
  "token price payout splits are emitted on generated assets",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { devnet: { address: "LegacyRecipient" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "split-api", wallet.id, {
      defaultScheme: "flex",
    });

    await createEndpoint(tenant.id, "/split", {
      scheme: "flex",
      http_method: "POST",
    });
    await createTokenPrice(tenant.id, null, {
      network: "solana-devnet",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payoutSplits: [
        { recipient: "ReceiverA", bps: 7000 },
        { recipient: "ReceiverB", bps: 3000 },
      ],
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    const assets = result.spec["x-faremeter-assets"] as Record<
      string,
      Record<string, unknown>
    >;
    t.matchOnly(assets["solana-devnet-USDC"], {
      chain: "solana-devnet",
      token: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6,
      recipient: "LegacyRecipient",
      splits: [
        { recipient: "ReceiverA", bps: 7000 },
        { recipient: "ReceiverB", bps: 3000 },
      ],
    });
  },
);

await t.test(
  "endpoint with null scheme inherits tenant default exact pricing",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLwALLeTaDdReSs123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "default-priced-api", wallet.id);

    await createEndpoint(tenant.id, "/v1/chat/completions", {
      scheme: null,
    });
    await createTokenPrice(tenant.id, null, {
      amount: 90000,
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    const paths = result.spec.paths as Record<string, Record<string, unknown>>;
    const route = paths["/v1/chat/completions"];
    t.ok(route);

    const post = route?.post as Record<string, unknown>;
    const pricing = post["x-faremeter-pricing"] as Record<string, unknown>;
    const rules = pricing.rules as Record<string, unknown>[];

    t.matchOnly(rules, [{ match: "true", capture: "90000" }]);
  },
);

await t.test("skips free endpoints", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "free-test", wallet.id);

  await createEndpoint(tenant.id, "/free-endpoint", { price: 0 });
  await createEndpoint(tenant.id, "/paid-endpoint", { scheme: "exact" });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  t.notOk(paths["/free-endpoint"]);
  t.ok(paths["/paid-endpoint"]);
});

await t.test("skips legacy free scheme endpoints", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "legacy-free-test", wallet.id);

  await createEndpoint(tenant.id, "/legacy-free", { scheme: "free" });
  await createEndpoint(tenant.id, "/paid-endpoint", { scheme: "exact" });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  t.notOk(paths["/legacy-free"]);
  t.ok(paths["/paid-endpoint"]);
});

await t.test("uses openapi_source_paths when present", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "source-paths", wallet.id);

  await createEndpoint(tenant.id, "/api/data", {
    scheme: "exact",
    openapi_source_paths: ["/v1/data", "/v2/data"],
  });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  t.ok(paths["/v1/data"]);
  t.ok(paths["/v2/data"]);
  t.notOk(paths["/api/data"]);
});

await t.test(
  "warns and skips endpoint with unconvertible path pattern",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "bad-path", wallet.id);

    // Regex pattern that can't be converted to OpenAPI
    await createEndpoint(tenant.id, "^/complex/(a|b)/.*$", {
      scheme: "exact",
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    const paths = result.spec.paths as Record<string, unknown>;
    t.same(Object.keys(paths), []);
    t.ok(result.warnings.length > 0);
    const firstWarning = result.warnings[0];
    t.ok(firstWarning);
    if (!firstWarning) return;
    t.ok(firstWarning.includes("Cannot convert"));
  },
);

await t.test("ANY endpoint expands to all standard methods", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "key-format", wallet.id);

  const endpoint = await createEndpoint(tenant.id, "/items/{itemId}", {
    scheme: "exact",
  });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  // ANY must emit all standard methods
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    t.equal(
      result.operationKeyToEndpointId[`${method} /items/{itemId}`],
      endpoint.id,
      `${method} should map to endpoint`,
    );
  }

  // ANY must NOT include HEAD or OPTIONS
  t.equal(
    result.operationKeyToEndpointId["HEAD /items/{itemId}"],
    undefined,
    "ANY must not expand to HEAD",
  );
  t.equal(
    result.operationKeyToEndpointId["OPTIONS /items/{itemId}"],
    undefined,
    "ANY must not expand to OPTIONS",
  );

  // OpenAPI paths should have all methods
  const paths = result.spec.paths as Record<string, Record<string, unknown>>;
  const pathEntry = paths["/items/{itemId}"];
  t.ok(pathEntry);
  if (!pathEntry) return;
  for (const m of ["get", "post", "put", "delete", "patch"]) {
    t.ok(pathEntry[m], `${m} operation should exist`);
  }
  t.equal(pathEntry.head, undefined, "ANY must not emit head operation");
  t.equal(pathEntry.options, undefined, "ANY must not emit options operation");
});

await t.test("endpoint-level token prices override tenant-level", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "ep-prices", wallet.id);

  const endpoint = await createEndpoint(tenant.id, "/special", {
    scheme: "exact",
    price: 5000,
  });

  // Tenant-level price
  await createTokenPrice(tenant.id, null, { amount: 1000 });

  // Endpoint-level price — should override
  await createTokenPrice(tenant.id, endpoint.id, { amount: 9999 });

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  const pathEntry = paths["/special"] as Record<string, unknown>;
  const getOp = pathEntry.get as Record<string, unknown>;
  const pricing = getOp["x-faremeter-pricing"] as Record<string, unknown>;
  const rules = pricing.rules as Record<string, unknown>[];

  t.equal(rules.length, 1);
  const rule0 = rules[0];
  t.ok(rule0);
  if (!rule0) return;
  t.equal(rule0.capture, "9999");
});

await t.test(
  "tenant-level prices scaled by endpoint price multiplier",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "scaled", wallet.id);

    await createEndpoint(tenant.id, "/double", {
      scheme: "exact",
      price: 2,
    });

    await createTokenPrice(tenant.id, null, { amount: 1000 });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    const paths = result.spec.paths as Record<string, unknown>;
    const pathEntry = paths["/double"] as Record<string, unknown>;
    const getOp = pathEntry.get as Record<string, unknown>;
    const pricing = getOp["x-faremeter-pricing"] as Record<string, unknown>;
    const rules = pricing.rules as Record<string, unknown>[];

    t.equal(rules.length, 1);
    const rule0 = rules[0];
    t.ok(rule0);
    if (!rule0) return;
    t.equal(rule0.capture, "2000");

    t.notOk(
      result.warnings.some((w) => w.includes("no price multiplier configured")),
      "must not warn when endpoint price is explicitly set",
    );
  },
);

await t.test("null endpoint price defaults multiplier to 1", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "null-price", wallet.id);

  await createEndpoint(tenant.id, "/default-multi", {
    scheme: "exact",
    price: null,
  });

  await createTokenPrice(tenant.id, null, { amount: 500 });

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  const pathEntry = paths["/default-multi"] as Record<string, unknown>;
  const getOp = pathEntry.get as Record<string, unknown>;
  const pricing = getOp["x-faremeter-pricing"] as Record<string, unknown>;
  const rules = pricing.rules as Record<string, unknown>[];

  t.equal(rules.length, 1);
  const rule0 = rules[0];
  t.ok(rule0);
  if (!rule0) return;
  t.equal(rule0.capture, "500");

  t.ok(
    result.warnings.some((w) => w.includes("no price multiplier configured")),
    "must warn when endpoint price is null",
  );
});

await t.test(
  "missing wallet address for network warns and skips asset",
  async (t) => {
    const org = await createOrg("Team", "team");
    // Wallet only has solana address, no base
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "missing-net", wallet.id);

    await createEndpoint(tenant.id, "/test", { scheme: "exact" });

    // Token price on a network with no wallet address
    await createTokenPrice(tenant.id, null, {
      network: "base",
      symbol: "USDC",
      mint: "0xbase-usdc",
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    // Asset should be absent
    const assets = result.spec["x-faremeter-assets"] as Record<string, unknown>;
    t.notOk(assets["base-USDC"]);

    // Warning should be present
    t.ok(result.warnings.some((w) => w.includes("base")));

    // No pricing rules because the only asset was skipped
    const paths = result.spec.paths as Record<string, unknown>;
    const pathEntry = paths["/test"] as Record<string, unknown>;
    const getOp = pathEntry.get as Record<string, unknown>;
    t.notOk(getOp["x-faremeter-pricing"]);
  },
);

await t.test("flex tenant paid endpoint produces pricing rules", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "flex-test", wallet.id, {
    defaultScheme: "flex",
  });

  await createEndpoint(tenant.id, "/flex-endpoint", {
    scheme: "exact",
    price: 5000,
  });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  const pathEntry = paths["/flex-endpoint"] as Record<string, unknown>;
  const getOp = pathEntry.get as Record<string, unknown>;
  const pricing = getOp["x-faremeter-pricing"] as Record<string, unknown>;
  const rules = pricing.rules as Record<string, unknown>[];
  t.matchOnly(rules, [{ match: "true", capture: "5000000" }]);
});

await t.test(
  "imported OpenAPI authorize and capture pricing is preserved and marks operation flex",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { devnet: { address: "recipient1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const importedSpec = {
      openapi: "3.0.3",
      info: { title: "Dynamic API", version: "1.0.0" },
      "x-faremeter-assets": {
        "usdc-sol": {
          chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          token: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          decimals: 6,
          recipient: "recipient1",
          splits: [
            { recipient: "recipient1", bps: 6000 },
            { recipient: "recipient2", bps: 4000 },
          ],
        },
      },
      "x-faremeter-pricing": {
        rates: { "usdc-sol": 1 },
        rules: [{ match: "$", capture: "10000" }],
      },
      paths: {
        "/v1/chat/completions": {
          post: {
            summary: "Token-metered chat completion",
            "x-faremeter-pricing": {
              rules: [
                {
                  match: '$[?@.request.body.model == "gpt-4o"]',
                  authorize:
                    "(jsonSize($.request.body.messages) / 4 * 10 + coalesce($.request.body.max_tokens, 1024) * 30) * 115 / 100",
                  capture:
                    "$.response.body.usage.prompt_tokens * 10 + $.response.body.usage.completion_tokens * 30",
                },
              ],
            },
          },
        },
      },
    };
    const tenant = await createTenant(org.id, "dynamic-flex", wallet.id, {
      defaultScheme: "exact",
      openapiSpec: importedSpec,
    });

    const endpoint = await createEndpoint(tenant.id, "/v1/chat/completions", {
      openapi_source_paths: ["/v1/chat/completions"],
      http_method: "POST",
      price: 1,
      scheme: null,
    });
    await createTokenPrice(tenant.id, null, {
      network: "solana-devnet",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    t.same(result.operationKeyToEndpointId, {
      "POST /v1/chat/completions": endpoint.id,
    });
    t.same(result.operationKeyToScheme, {
      "POST /v1/chat/completions": "flex",
    });
    t.equal(
      (result.spec.info as Record<string, unknown>).title,
      "dynamic-flex",
    );
    const assets = result.spec["x-faremeter-assets"] as Record<string, unknown>;
    t.ok(assets["solana-devnet-USDC"]);
    t.matchOnly(
      assets["usdc-sol"],
      importedSpec["x-faremeter-assets"]["usdc-sol"],
    );
    const rootPricing = result.spec["x-faremeter-pricing"] as Record<
      string,
      unknown
    >;
    t.matchOnly(rootPricing.rates, {
      "usdc-sol": 1,
      "solana-devnet-USDC": 1,
    });
    t.same(rootPricing.rules, importedSpec["x-faremeter-pricing"].rules);

    const paths = result.spec.paths as Record<string, unknown>;
    const pathEntry = paths["/v1/chat/completions"] as Record<string, unknown>;
    const post = pathEntry.post as Record<string, unknown>;
    const pricing = post["x-faremeter-pricing"] as Record<string, unknown>;
    t.matchOnly(
      pricing.rules,
      importedSpec.paths["/v1/chat/completions"].post["x-faremeter-pricing"]
        .rules,
    );
  },
);

await t.test(
  "endpoint-level price on unconfigured network produces no rules without fallback",
  async (t) => {
    const org = await createOrg("Team", "team");
    // Wallet only has solana, not base
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "no-fallback", wallet.id);

    const endpoint = await createEndpoint(tenant.id, "/partial", {
      scheme: "exact",
    });

    // Tenant-level price on solana (has wallet address)
    await createTokenPrice(tenant.id, null, {
      network: "solana-mainnet-beta",
      symbol: "USDC",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });

    // Endpoint-level price on base (no wallet address)
    await createTokenPrice(tenant.id, endpoint.id, {
      network: "base",
      symbol: "USDC",
      mint: "0xbase-usdc",
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    // Warning about missing base wallet
    t.ok(result.warnings.some((w) => w.includes("base")));

    // No pricing rules — endpoint-level branch entered but all skipped,
    // does NOT fall back to tenant-level prices
    const paths = result.spec.paths as Record<string, unknown>;
    const pathEntry = paths["/partial"] as Record<string, unknown>;
    const getOp = pathEntry.get as Record<string, unknown>;
    t.notOk(getOp["x-faremeter-pricing"]);
  },
);

await t.test("POST endpoint emits post operation and POST key", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const tenant = await createTenant(org.id, "post-test", wallet.id);

  const endpoint = await createEndpoint(tenant.id, "/submit", {
    scheme: "exact",
    http_method: "POST",
  });
  await createTokenPrice(tenant.id, null);

  const result = await buildTenantGatewaySpec(tenant.id);
  t.not(result, null);
  if (!result) return;

  const paths = result.spec.paths as Record<string, unknown>;
  const pathEntry = paths["/submit"] as Record<string, unknown>;
  t.ok(pathEntry);
  if (!pathEntry) return;

  // Should emit post, not get
  t.ok(pathEntry.post);
  t.notOk(pathEntry.get);

  // Operation key uses POST
  t.equal(result.operationKeyToEndpointId["POST /submit"], endpoint.id);
  t.equal(result.operationKeyToEndpointId["GET /submit"], undefined);
});

await t.test(
  "two endpoints on same path with different methods produce independent operations",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "multi-method", wallet.id);

    const getEndpoint = await createEndpoint(tenant.id, "/resource", {
      scheme: "exact",
      http_method: "GET",
    });
    const putEndpoint = await createEndpoint(tenant.id, "/resource", {
      scheme: "exact",
      http_method: "PUT",
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    const paths = result.spec.paths as Record<string, unknown>;
    const pathEntry = paths["/resource"] as Record<string, unknown>;
    t.ok(pathEntry);
    if (!pathEntry) return;

    // Both methods present
    t.ok(pathEntry.get);
    t.ok(pathEntry.put);

    // Independent operation keys
    t.equal(result.operationKeyToEndpointId["GET /resource"], getEndpoint.id);
    t.equal(result.operationKeyToEndpointId["PUT /resource"], putEndpoint.id);
  },
);

await t.test(
  "duplicate path+method: higher-priority endpoint wins and warning is emitted",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "dup-method", wallet.id);

    const first = await createEndpoint(tenant.id, "/data", {
      scheme: "exact",
      http_method: "GET",
      priority: 10,
    });
    await createEndpoint(tenant.id, "/data", {
      scheme: "exact",
      http_method: "GET",
      priority: 20,
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    // First endpoint (priority 10) wins
    t.equal(result.operationKeyToEndpointId["GET /data"], first.id);

    // Warning emitted for the duplicate
    const dupWarning = result.warnings.find((w) =>
      w.includes('Duplicate operation "GET /data"'),
    );
    t.ok(dupWarning, "should warn about duplicate operation");
  },
);

await t.test(
  "duplicate path collision only affects the colliding path, not other paths on the same endpoint",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "addr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "partial-dup", wallet.id);

    const first = await createEndpoint(tenant.id, "/shared", {
      scheme: "exact",
      http_method: "GET",
      priority: 10,
    });
    const second = await createEndpoint(tenant.id, "/unique", {
      scheme: "exact",
      http_method: "GET",
      priority: 20,
      openapi_source_paths: ["/shared", "/unique"],
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    // /shared claimed by first endpoint
    t.equal(result.operationKeyToEndpointId["GET /shared"], first.id);

    // /unique still emitted for second endpoint
    t.equal(result.operationKeyToEndpointId["GET /unique"], second.id);

    const paths = result.spec.paths as Record<string, Record<string, unknown>>;
    t.ok(paths["/shared"]?.get, "/shared should have GET");
    t.ok(paths["/unique"]?.get, "/unique should have GET");

    // Warning for the collision on /shared
    const dupWarning = result.warnings.find((w) =>
      w.includes('Duplicate operation "GET /shared"'),
    );
    t.ok(dupWarning, "should warn about /shared collision");
  },
);

await t.test(
  "endpoint-level price on network without tenant-level price populates asset from wallet",
  async (t) => {
    const org = await createOrg("Team", "team");
    // Wallet has both solana and base addresses
    const walletConfig = {
      solana: { "mainnet-beta": { address: "solAddr1" } },
      evm: { base: { address: "baseAddr1" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "ep-only-net", wallet.id);

    const endpoint = await createEndpoint(tenant.id, "/pay", {
      scheme: "exact",
    });

    // Tenant-level price on solana only
    await createTokenPrice(tenant.id, null, {
      network: "solana-mainnet-beta",
      symbol: "USDC",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });

    // Endpoint-level price on base (wallet has address, but no tenant-level price)
    await createTokenPrice(tenant.id, endpoint.id, {
      network: "base",
      symbol: "USDC",
      mint: "0xbase-usdc",
      amount: 500,
      decimals: 6,
    });

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    // No warnings — base has a wallet address
    const baseWarning = result.warnings.find(
      (w) => w.includes("base") && w.includes("no wallet"),
    );
    t.notOk(baseWarning, "should not warn about base network");

    // The base asset should have been populated
    const assets = result.spec["x-faremeter-assets"] as Record<
      string,
      Record<string, unknown>
    >;
    t.ok(assets["base-USDC"], "base-USDC asset should exist");
    t.equal(assets["base-USDC"]?.recipient, "baseAddr1");

    // Pricing rules should exist on the endpoint
    const paths = result.spec.paths as Record<string, Record<string, unknown>>;
    const getOp = paths["/pay"]?.get as Record<string, unknown> | undefined;
    t.ok(getOp, "GET /pay should exist");
    if (!getOp) return;

    const pricing = getOp["x-faremeter-pricing"] as
      | { rules: unknown[] }
      | undefined;
    t.ok(pricing, "should have pricing extension");
    if (!pricing) return;
    t.ok(pricing.rules.length > 0, "should have at least one pricing rule");
  },
);

await t.test(
  "HEAD endpoint produces a head operation and HEAD operation key",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = { solana: { "mainnet-beta": { address: "addr1" } } };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "head-test", wallet.id);

    const endpoint = await createEndpoint(tenant.id, "/status", {
      scheme: "exact",
      http_method: "HEAD",
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    t.equal(
      result.operationKeyToEndpointId["HEAD /status"],
      endpoint.id,
      "HEAD /status should map to endpoint",
    );

    const paths = result.spec.paths as Record<string, Record<string, unknown>>;
    t.ok(paths["/status"]?.head, "head operation should exist");
    t.equal(paths["/status"]?.get, undefined, "get must not exist for HEAD");
  },
);

await t.test(
  "OPTIONS endpoint produces an options operation and OPTIONS operation key",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = { solana: { "mainnet-beta": { address: "addr1" } } };
    const wallet = await createWallet(org.id, walletConfig);
    const tenant = await createTenant(org.id, "options-test", wallet.id);

    const endpoint = await createEndpoint(tenant.id, "/cors", {
      scheme: "exact",
      http_method: "OPTIONS",
    });
    await createTokenPrice(tenant.id, null);

    const result = await buildTenantGatewaySpec(tenant.id);
    t.not(result, null);
    if (!result) return;

    t.equal(
      result.operationKeyToEndpointId["OPTIONS /cors"],
      endpoint.id,
      "OPTIONS /cors should map to endpoint",
    );

    const paths = result.spec.paths as Record<string, Record<string, unknown>>;
    t.ok(paths["/cors"]?.options, "options operation should exist");
    t.equal(paths["/cors"]?.get, undefined, "get must not exist for OPTIONS");
  },
);
