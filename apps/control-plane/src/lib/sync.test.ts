import "../tests/setup/env.js";
import t from "tap";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { buildNodeConfig } from "./sync.js";

await setupTestSchema();

async function createOrg(name: string, slug: string) {
  return db
    .insertInto("organizations")
    .values({ name, slug })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createWallet(orgId: number, config: Record<string, unknown>) {
  return db
    .insertInto("wallets")
    .values({
      name: "test-wallet",
      organization_id: orgId,
      funding_status: "funded",
      wallet_config: JSON.stringify(config),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createNode(name: string) {
  return db
    .insertInto("nodes")
    .values({ name, internal_ip: "10.0.0.1", status: "active" })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTenant(
  orgId: number,
  name: string,
  walletId: number,
  opts: {
    org_slug?: string | null;
    upstream_auth_header?: string | null;
    upstream_auth_value?: string | null;
  } = {},
) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: "http://backend.example.test",
      default_price: 0.01,
      default_scheme: "exact",
      wallet_id: walletId,
      status: "active",
      is_active: true,
      org_slug: opts.org_slug ?? null,
      upstream_auth_header: opts.upstream_auth_header ?? null,
      upstream_auth_value: opts.upstream_auth_value ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function linkTenantToNode(tenantId: number, nodeId: number) {
  await db
    .insertInto("tenant_nodes")
    .values({ tenant_id: tenantId, node_id: nodeId })
    .execute();
}

async function createEndpoint(
  tenantId: number,
  path: string,
  opts: { price?: number | null; scheme?: string } = {},
) {
  return db
    .insertInto("endpoints")
    .values({
      tenant_id: tenantId,
      path,
      path_pattern: path,
      price: opts.price ?? null,
      scheme: opts.scheme ?? "exact",
      priority: 100,
      is_active: true,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTokenPrice(
  tenantId: number,
  endpointId: number | null,
  opts: {
    network?: string;
    symbol?: string;
    mint?: string;
    amount?: number;
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
      decimals: 6,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("returns null for nonexistent node", async (t) => {
  const result = await buildNodeConfig(999);
  t.equal(result, null);
});

await t.test("includes tenant without org_slug", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "addr1" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "no-slug", wallet.id, {
    org_slug: null,
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/test");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const domain = "no-slug.api.example.test";
  t.ok(result.config[domain], "tenant appears in config");
  const cfg = result.config[domain] as Record<string, unknown>;
  t.equal(cfg.org_slug, null);
  t.equal(cfg.gateway_slug, "no-slug");

  t.ok(result.gateway["no-slug"], "gateway keyed by tenant name");
  t.ok(result.sidecar.sites["no-slug"], "sidecar keyed by tenant name");
});

await t.test(
  "skips tenant when buildTenantGatewaySpec returns null",
  async (t) => {
    const org = await createOrg("Team", "team");
    // Invalid wallet config will cause buildTenantGatewaySpec to return null
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
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "bad-config", wallet.id, {
      org_slug: "bad-config",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/test");
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    t.same(result.gateway, {});
    t.same(result.sidecar.sites, {});
    t.equal(
      Object.keys(result.config).length,
      0,
      "skipped tenant must not appear in config",
    );
  },
);

await t.test(
  "tenant populates config, gateway, and sidecar keys",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "my-api", wallet.id, {
      org_slug: "team",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/items/{id}", { scheme: "exact" });
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    // Gateway config keyed by gateway_slug
    t.ok(result.gateway["team--my-api"]);
    const gw = result.gateway["team--my-api"] as Record<string, unknown>;
    t.ok(gw.spec);
    t.ok(gw.locationsConf);
    t.ok(gw.luaFiles);
    t.equal(gw.sidecarPrefix, "team--my-api");
    t.ok((gw.baseURL as string).includes("my-api"));

    // Sidecar config keyed by gateway_slug
    t.ok(result.sidecar.sites["team--my-api"]);
    const site = result.sidecar.sites["team--my-api"] as Record<
      string,
      unknown
    >;
    t.ok(site.spec);
    t.equal(site.tenantName, "my-api");
    t.equal(site.orgSlug, "team");
    t.same(site.capabilities, {
      schemes: ["exact"],
      networks: ["solana-mainnet-beta"],
      assets: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    });

    // Facilitator URL from env
    t.equal(result.sidecar.facilitatorURL, "http://facilitator.example.test");

    // Config populated for upstream-auth.lua and free-recording.lua
    const configKeys = Object.keys(result.config);
    t.equal(configKeys.length, 1, "tenant must appear in config");
    const tenantConfig = Object.values(result.config)[0] as Record<
      string,
      unknown
    >;
    t.equal(tenantConfig.backend_url, "http://backend.example.test");
    t.equal(tenantConfig.org_slug, "team");
    t.equal(tenantConfig.gateway_slug, "team--my-api");
    t.equal(tenantConfig.name, "my-api");
  },
);

await t.test(
  "flex-only tenant populates pricing and flex sidecar capabilities",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "flex-api", wallet.id, {
      org_slug: "team",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/flex/completions", {
      scheme: "flex",
    });
    await createTokenPrice(tenant.id, null, { amount: 10000 });

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const site = result.sidecar.sites["team--flex-api"] as Record<
      string,
      unknown
    >;
    t.ok(site, "sidecar entry exists");
    t.same(site.capabilities, {
      schemes: ["flex"],
      networks: ["solana-mainnet-beta"],
      assets: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    });
    t.match(site.operationKeyToScheme, {
      "POST /v1/flex/completions": "flex",
    });

    const spec = site.spec as Record<string, unknown>;
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const post = paths["/v1/flex/completions"]?.post as
      | Record<string, unknown>
      | undefined;
    t.ok(post, "flex endpoint should be emitted as a POST operation");
    if (!post) return;

    const pricing = post["x-faremeter-pricing"] as
      | { rules: Record<string, unknown>[] }
      | undefined;
    t.ok(pricing, "flex endpoint should have gateway pricing");
    t.matchOnly(pricing?.rules, [{ match: "true", capture: "10000" }]);
  },
);

await t.test(
  "mixed exact and flex tenant records per-operation schemes",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "mixed-api", wallet.id, {
      org_slug: "team",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/chat/completions", {
      scheme: "exact",
    });
    await createEndpoint(tenant.id, "/v1/flex/completions", {
      scheme: "flex",
    });
    await createTokenPrice(tenant.id, null, { amount: 10000 });

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const site = result.sidecar.sites["team--mixed-api"] as Record<
      string,
      unknown
    >;
    t.ok(site, "sidecar entry exists");
    t.same(site.capabilities, {
      schemes: ["exact", "flex"],
      networks: ["solana-mainnet-beta"],
      assets: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    });
    t.match(site.operationKeyToScheme, {
      "POST /v1/chat/completions": "exact",
      "POST /v1/flex/completions": "flex",
    });

    const gw = result.gateway["team--mixed-api"] as Record<string, unknown>;
    t.same(gw.operationKeyToScheme, site.operationKeyToScheme);
  },
);

await t.test(
  "upstream auth header is injected into gateway locations via extraDirectives",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "authed-api", wallet.id, {
      org_slug: "team",
      upstream_auth_header: "X-Api-Key",
      upstream_auth_value: "secret-key-123",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/completions");
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const gw = result.gateway["team--authed-api"] as Record<string, unknown>;
    t.ok(gw, "gateway entry exists");
    const locationsConf = gw.locationsConf as string;
    t.ok(
      locationsConf.includes('proxy_set_header X-Api-Key "secret-key-123";'),
      "upstream auth header appears in generated locations",
    );
  },
);

await t.test(
  "no extraDirectives when upstream auth is not configured",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "no-auth-api", wallet.id, {
      org_slug: "team",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/completions");
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const gw = result.gateway["team--no-auth-api"] as Record<string, unknown>;
    t.ok(gw, "gateway entry exists");
    const locationsConf = gw.locationsConf as string;
    t.notMatch(
      locationsConf,
      /proxy_set_header.*X-Api-Key/,
      "no auth header in generated locations",
    );
  },
);

await t.test(
  "no extraDirectives when only upstream_auth_header is set",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "half-auth", wallet.id, {
      org_slug: "team",
      upstream_auth_header: "X-Api-Key",
      upstream_auth_value: null,
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/completions");
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const gw = result.gateway["team--half-auth"] as Record<string, unknown>;
    t.ok(gw, "gateway entry exists");
    const locationsConf = gw.locationsConf as string;
    t.notMatch(
      locationsConf,
      /proxy_set_header.*X-Api-Key/,
      "no auth header when value is null",
    );
  },
);

await t.test("rejects unsafe characters in upstream auth values", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "bad-auth", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Api-Key",
    upstream_auth_value: 'secret"; proxy_pass http://evil.test; #',
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--bad-auth"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Api-Key/,
    "auth header with injection payload must not appear",
  );
  t.notMatch(
    locationsConf,
    /evil\.test/,
    "injected proxy_pass must not appear",
  );
});

await t.test(
  "rejects unsafe characters in upstream auth header name",
  async (t) => {
    const org = await createOrg("Team", "team");
    const walletConfig = {
      solana: { "mainnet-beta": { address: "SoLAddr123" } },
    };
    const wallet = await createWallet(org.id, walletConfig);
    const node = await createNode("node-1");
    const tenant = await createTenant(org.id, "bad-header", wallet.id, {
      org_slug: "team",
      upstream_auth_header: 'X-Key"\nproxy_pass http://evil.test',
      upstream_auth_value: "legit-value",
    });
    await linkTenantToNode(tenant.id, node.id);
    await createEndpoint(tenant.id, "/v1/completions");
    await createTokenPrice(tenant.id, null);

    const result = await buildNodeConfig(node.id);
    t.not(result, null);
    if (!result) return;

    const gw = result.gateway["team--bad-header"] as Record<string, unknown>;
    t.ok(gw, "gateway entry exists");
    const locationsConf = gw.locationsConf as string;
    t.notMatch(
      locationsConf,
      /evil\.test/,
      "injected payload via header name must not appear",
    );
  },
);

await t.test("rejects dollar signs in upstream auth value", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "dollar-auth", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Api-Key",
    upstream_auth_value: "${http_authorization}",
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--dollar-auth"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Api-Key/,
    "auth header with variable reference must not appear",
  );
});

await t.test("rejects trailing backslash in upstream auth value", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "backslash-auth", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Api-Key",
    upstream_auth_value: "secret-key\\",
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--backslash-auth"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Api-Key/,
    "auth header with trailing backslash must not appear",
  );
});

await t.test("rejects brace in upstream auth header name", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "brace-header", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Key}",
    upstream_auth_value: "legit-value",
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--brace-header"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Key/,
    "header name with closing brace must not appear",
  );
});

await t.test("rejects hash in upstream auth header name", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "hash-header", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Key#comment",
    upstream_auth_value: "legit-value",
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--hash-header"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Key/,
    "header name with hash must not appear",
  );
});

await t.test("rejects space in upstream auth header name", async (t) => {
  const org = await createOrg("Team", "team");
  const walletConfig = {
    solana: { "mainnet-beta": { address: "SoLAddr123" } },
  };
  const wallet = await createWallet(org.id, walletConfig);
  const node = await createNode("node-1");
  const tenant = await createTenant(org.id, "space-header", wallet.id, {
    org_slug: "team",
    upstream_auth_header: "X-Key evil-directive",
    upstream_auth_value: "legit-value",
  });
  await linkTenantToNode(tenant.id, node.id);
  await createEndpoint(tenant.id, "/v1/completions");
  await createTokenPrice(tenant.id, null);

  const result = await buildNodeConfig(node.id);
  t.not(result, null);
  if (!result) return;

  const gw = result.gateway["team--space-header"] as Record<string, unknown>;
  t.ok(gw, "gateway entry exists");
  const locationsConf = gw.locationsConf as string;
  t.notMatch(
    locationsConf,
    /proxy_set_header.*X-Key/,
    "header name with space must not appear",
  );
});
