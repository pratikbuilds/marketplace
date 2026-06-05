import "dotenv/config";
import { request as httpRequest } from "node:http";
import fs from "node:fs";
import bcrypt from "bcrypt";
import bs58 from "bs58";
import { solana } from "@faremeter/info";
import { db } from "../db/instance.js";
import { toDomainInfo } from "../lib/domain.js";
import { triggerCertProvisioning } from "../lib/cert.js";
import { enqueueBalanceCheck } from "../lib/queue.js";
import { syncToNode } from "../lib/sync.js";
import { logger } from "../logger.js";

const CONTROL_PLANE_BASE_URL =
  process.env.LOCAL_CONTROL_PLANE_BASE_URL ?? "http://control-plane:1337";
const ADMIN_EMAIL =
  process.env.LOCAL_ADMIN_EMAIL ?? "admin@local.faremeter.test";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD ?? "localdev123";
const ORG_NAME = "Local Dev Org";
const ORG_SLUG = "local";
const WALLET_NAME = "Local Dev Wallet";
const EXACT_TENANT_NAME = "demo-api";
const FLEX_TENANT_NAME = "demo-flex-api";
const DEMO_BACKEND_URL =
  process.env.LOCAL_PUBLISHER_URL ?? "http://publisher-mock:3001";
const DEMO_PRICE = parseInt(process.env.LOCAL_DEMO_PRICE ?? "1000", 10);
const PROXY_BASE_DOMAIN = process.env.PROXY_BASE_DOMAIN ?? "proxy.localhost";
const EXACT_PROXY_DOMAIN = `${EXACT_TENANT_NAME}.${ORG_SLUG}.${PROXY_BASE_DOMAIN}`;
const FLEX_PROXY_DOMAIN = `${FLEX_TENANT_NAME}.${ORG_SLUG}.${PROXY_BASE_DOMAIN}`;
const PRIMARY_PROXY_PORT = process.env.PROXY_BASE_PORT ?? "18080";
const SECONDARY_PROXY_PORT = process.env.LOCAL_SECONDARY_PROXY_PORT ?? "18081";

const rawSolanaCluster = process.env.SOLANA_NETWORK ?? "devnet";
if (!solana.isKnownCluster(rawSolanaCluster)) {
  throw new Error(
    `Unsupported SOLANA_NETWORK for local dev: ${rawSolanaCluster}`,
  );
}

function getSolanaUsdc(cluster: solana.KnownCluster) {
  const token = solana.lookupKnownSPLToken(cluster, "USDC");
  if (!token) {
    throw new Error(`Couldn't look up USDC on Solana ${cluster}`);
  }
  return token;
}

function getSolanaNetworkId(cluster: solana.KnownCluster): string {
  const network = solana.getV1NetworkIds(cluster)[0];
  if (!network) {
    throw new Error(`Couldn't derive an x402 network ID for ${cluster}`);
  }
  return network;
}

const SOLANA_CLUSTER = rawSolanaCluster;
const SOLANA_USDC = getSolanaUsdc(SOLANA_CLUSTER);
const SOLANA_NETWORK = getSolanaNetworkId(SOLANA_CLUSTER);

const NODE_CONFIGS = [
  {
    name: "local-api-node-a",
    internalIp: "api-node-a",
    publicIp: "127.0.0.1",
    publicPort: PRIMARY_PROXY_PORT,
  },
  {
    name: "local-api-node-b",
    internalIp: "api-node-b",
    publicIp: "127.0.0.2",
    publicPort: SECONDARY_PROXY_PORT,
  },
] as const;

type OrganizationRecord = {
  id: number;
  slug: string;
};

type NodeRecord = {
  id: number;
  name: string;
  internalIp: string;
};

type CreatedWallet = {
  id: number;
  funding_status: string;
};

type CreatedTenant = {
  id: number;
  status: string;
};

type SeedEndpoint = {
  id: number;
  path: string | null;
};

function getServiceWalletAddress(): string {
  const explicit = process.env.LOCAL_SERVICE_SOLANA_ADDRESS?.trim();
  if (explicit) {
    return explicit;
  }

  const keypairPath = process.env.LOCAL_FACILITATOR_SOLANA_KEYPAIR_PATH?.trim();
  if (!keypairPath) {
    throw new Error(
      "Set LOCAL_FACILITATOR_SOLANA_KEYPAIR_PATH or LOCAL_SERVICE_SOLANA_ADDRESS before seeding local dev.",
    );
  }

  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(keypairPath, "utf8")),
  );
  if (secret.length !== 64) {
    throw new Error(`Expected 64-byte Solana keypair at ${keypairPath}`);
  }
  return bs58.encode(secret.slice(32));
}

async function waitFor(
  url: string,
  label: string,
  init?: RequestInit,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

async function waitForWalletFunded(walletId: number): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const wallet = await db
      .selectFrom("wallets")
      .select(["funding_status"])
      .where("id", "=", walletId)
      .executeTakeFirst();

    if (wallet?.funding_status === "funded") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Wallet ${walletId} did not become funded in time`);
}

async function waitForTenantActive(tenantId: number): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const tenant = await db
      .selectFrom("tenants")
      .select(["status", "is_active"])
      .where("id", "=", tenantId)
      .executeTakeFirst();

    if (tenant?.status === "active" && tenant.is_active) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Tenant ${tenantId} did not become active in time`);
}

async function waitForProxyPaymentRequired(
  internalIp: string,
  proxyDomain: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  const body = JSON.stringify({
    model: "local-demo",
    messages: [{ role: "user", content: "health check" }],
  });

  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          host: internalIp,
          port: 80,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            Host: proxyDomain,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        });

        request.setTimeout(5_000, () => {
          request.destroy(new Error(`proxy ${internalIp} timed out`));
        });

        request.on("response", (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        });
        request.on("error", reject);
        request.write(body);
        request.end();
      });

      if (status === 402) {
        return;
      }

      lastError = new Error(
        `proxy ${internalIp} returned ${status} instead of 402`,
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for proxy config on ${internalIp}`, {
    cause: lastError,
  });
}

async function ensureOrganization(): Promise<OrganizationRecord> {
  const existing = await db
    .selectFrom("organizations")
    .select(["id", "slug"])
    .where("slug", "=", ORG_SLUG)
    .executeTakeFirst();

  if (existing) {
    return await db
      .updateTable("organizations")
      .set({
        name: ORG_NAME,
        onboarding_completed: true,
        onboarding_completed_at: new Date(),
      })
      .where("id", "=", existing.id)
      .returning(["id", "slug"])
      .executeTakeFirstOrThrow();
  }

  return await db
    .insertInto("organizations")
    .values({
      name: ORG_NAME,
      slug: ORG_SLUG,
      onboarding_completed: true,
      onboarding_completed_at: new Date(),
    })
    .returning(["id", "slug"])
    .executeTakeFirstOrThrow();
}

async function ensureUser() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", ADMIN_EMAIL)
    .executeTakeFirst();

  if (existing) {
    return await db
      .updateTable("users")
      .set({
        password_hash: passwordHash,
        is_admin: true,
        email_verified: true,
        verification_token: null,
        verification_expires: null,
      })
      .where("id", "=", existing.id)
      .returning(["id"])
      .executeTakeFirstOrThrow();
  }

  return await db
    .insertInto("users")
    .values({
      email: ADMIN_EMAIL,
      password_hash: passwordHash,
      is_admin: true,
      email_verified: true,
      verification_token: null,
      verification_expires: null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function ensureMembership(userId: number, organizationId: number) {
  const existing = await db
    .selectFrom("user_organizations")
    .select("id")
    .where("user_id", "=", userId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("user_organizations")
      .set({ role: "owner" })
      .where("id", "=", existing.id)
      .execute();
    return;
  }

  await db
    .insertInto("user_organizations")
    .values({
      user_id: userId,
      organization_id: organizationId,
      role: "owner",
    })
    .execute();
}

async function ensureNodes(): Promise<NodeRecord[]> {
  const nodes: NodeRecord[] = [];

  for (const config of NODE_CONFIGS) {
    const existing = await db
      .selectFrom("nodes")
      .select(["id"])
      .where("name", "=", config.name)
      .executeTakeFirst();

    if (existing) {
      const node = await db
        .updateTable("nodes")
        .set({
          internal_ip: config.internalIp,
          public_ip: config.publicIp,
          status: "active",
        })
        .where("id", "=", existing.id)
        .returning(["id"])
        .executeTakeFirstOrThrow();

      nodes.push({
        id: node.id,
        name: config.name,
        internalIp: config.internalIp,
      });
      continue;
    }

    const node = await db
      .insertInto("nodes")
      .values({
        name: config.name,
        internal_ip: config.internalIp,
        public_ip: config.publicIp,
        status: "active",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    nodes.push({
      id: node.id,
      name: config.name,
      internalIp: config.internalIp,
    });
  }

  return nodes;
}

async function ensureSupportedToken() {
  await db
    .deleteFrom("supported_tokens")
    .where("symbol", "=", "TEST")
    .execute();

  await db
    .insertInto("supported_tokens")
    .values({
      symbol: "USDC",
      mint_address: SOLANA_USDC.address,
      network: SOLANA_NETWORK,
      is_usd_pegged: true,
      decimals: 6,
    })
    .onConflict((oc) =>
      oc.columns(["symbol", "network"]).doUpdateSet({
        mint_address: SOLANA_USDC.address,
        is_usd_pegged: true,
        decimals: 6,
      }),
    )
    .execute();
}

async function ensureLocalFundingSettings() {
  const existing = await db
    .selectFrom("admin_settings")
    .select("id")
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("admin_settings")
      .set({
        minimum_balance_sol: 0,
        minimum_balance_usdc: 0,
      })
      .where("id", "=", existing.id)
      .execute();
    return;
  }

  await db
    .insertInto("admin_settings")
    .values({
      minimum_balance_sol: 0,
      minimum_balance_usdc: 0,
    })
    .execute();
}

async function cleanupDemoData(organizationId: number, nodeIds: number[]) {
  const existingTenants = await db
    .selectFrom("tenants")
    .select(["id"])
    .where("organization_id", "=", organizationId)
    .where("name", "in", [EXACT_TENANT_NAME, FLEX_TENANT_NAME])
    .execute();

  for (const existingTenant of existingTenants) {
    await db
      .deleteFrom("transactions")
      .where("tenant_id", "=", existingTenant.id)
      .execute();
    await db
      .deleteFrom("token_prices")
      .where("tenant_id", "=", existingTenant.id)
      .execute();
    await db
      .deleteFrom("endpoints")
      .where("tenant_id", "=", existingTenant.id)
      .execute();
    await db
      .deleteFrom("tenant_nodes")
      .where("tenant_id", "=", existingTenant.id)
      .execute();
    await db
      .deleteFrom("tenants")
      .where("id", "=", existingTenant.id)
      .execute();
  }

  await db
    .deleteFrom("wallets")
    .where("organization_id", "=", organizationId)
    .where("name", "=", WALLET_NAME)
    .execute();

  for (const nodeId of nodeIds) {
    await syncToNode(nodeId);
  }
}

async function apiJson<T>(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (init.cookie) {
    headers.set("Cookie", init.cookie);
  }

  const response = await fetch(`${CONTROL_PLANE_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`,
    );
  }

  return (await response.json()) as T;
}

async function login(): Promise<string> {
  const response = await fetch(`${CONTROL_PLANE_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login failed: ${response.status} ${text}`);
  }

  const rawCookie = response.headers.get("set-cookie");
  if (!rawCookie) {
    throw new Error("Login succeeded but auth cookie was not set");
  }

  const firstCookie = rawCookie.split(";")[0];
  if (!firstCookie) {
    throw new Error("Could not parse auth cookie");
  }

  return firstCookie;
}

async function createWallet(
  organizationId: number,
  authCookie: string,
  address: string,
): Promise<CreatedWallet> {
  return await apiJson<CreatedWallet>(
    `/api/wallets/organization/${organizationId}`,
    {
      method: "POST",
      cookie: authCookie,
      body: JSON.stringify({
        name: WALLET_NAME,
        wallet_config: {
          solana: {
            [SOLANA_CLUSTER]: {
              address,
            },
          },
        },
      }),
    },
  );
}

async function createTenant(
  organizationId: number,
  authCookie: string,
  walletId: number,
  name: string,
  defaultScheme: "exact" | "flex",
): Promise<CreatedTenant> {
  return await apiJson<CreatedTenant>(
    `/api/organizations/${organizationId}/tenants`,
    {
      method: "POST",
      cookie: authCookie,
      body: JSON.stringify({
        name,
        backend_url: DEMO_BACKEND_URL,
        wallet_id: walletId,
        default_price: DEMO_PRICE,
        default_scheme: defaultScheme,
      }),
    },
  );
}

async function createExactEndpoint(tenantId: number, authCookie: string) {
  await apiJson(`/api/tenants/${tenantId}/endpoints`, {
    method: "POST",
    cookie: authCookie,
    body: JSON.stringify({
      path: "/v1/chat/completions",
      price: 1,
      scheme: "exact",
      http_method: "POST",
      description: "Exact paid demo route",
      priority: 10,
    }),
  });
}

async function getPublisherOpenApiSpec(): Promise<object> {
  const response = await fetch(`${DEMO_BACKEND_URL}/openapi.json`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Publisher OpenAPI fetch failed: ${response.status} ${text}`,
    );
  }

  const spec: unknown = await response.json();
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("Publisher OpenAPI schema must be a JSON object");
  }

  return spec;
}

async function importPublisherOpenApiSpec(
  tenantId: number,
  authCookie: string,
) {
  const spec = await getPublisherOpenApiSpec();

  await apiJson(`/api/tenants/${tenantId}/openapi/import`, {
    method: "POST",
    cookie: authCookie,
    body: JSON.stringify({
      spec,
    }),
  });

  const endpoints = await apiJson<SeedEndpoint[]>(
    `/api/tenants/${tenantId}/endpoints`,
    {
      cookie: authCookie,
    },
  );

  const publisherPaths = new Set(["/v1/chat/completions"]);
  for (const endpoint of endpoints) {
    if (!endpoint.path || !publisherPaths.has(endpoint.path)) continue;

    await apiJson(`/api/tenants/${tenantId}/endpoints/${endpoint.id}`, {
      method: "PUT",
      cookie: authCookie,
      body: JSON.stringify({
        http_method: "POST",
        priority: 10,
      }),
    });
  }
}

async function useOnlyLocalSolanaUsdc(tenantId: number) {
  await db
    .deleteFrom("token_prices")
    .where("tenant_id", "=", tenantId)
    .execute();

  await db
    .insertInto("token_prices")
    .values({
      tenant_id: tenantId,
      endpoint_id: null,
      token_symbol: "USDC",
      mint_address: SOLANA_USDC.address,
      network: SOLANA_NETWORK,
      amount: DEMO_PRICE,
      decimals: 6,
    })
    .execute();
}

async function main() {
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "seed-local-dev.ts refuses to run outside NODE_ENV=development",
    );
  }

  logger.info("Seeding local developer stack with production-like flow...");

  const serviceWalletAddress = getServiceWalletAddress();
  const organization = await ensureOrganization();
  const user = await ensureUser();
  await ensureMembership(user.id, organization.id);
  const nodes = await ensureNodes();
  await ensureSupportedToken();
  await ensureLocalFundingSettings();

  await waitFor(`${CONTROL_PLANE_BASE_URL}/health`, "control-plane");
  for (const node of nodes) {
    await waitFor(`http://${node.internalIp}/health`, node.name);
  }

  await cleanupDemoData(
    organization.id,
    nodes.map((node) => node.id),
  );

  const authCookie = await login();
  const wallet = await createWallet(
    organization.id,
    authCookie,
    serviceWalletAddress,
  );

  // The seed container is separate from the control-plane process. We still
  // create the wallet via the public route, but we complete the funding check
  // here as a deterministic bootstrap step.
  await enqueueBalanceCheck(wallet.id, null);
  await waitForWalletFunded(wallet.id);

  const exactTenant = await createTenant(
    organization.id,
    authCookie,
    wallet.id,
    EXACT_TENANT_NAME,
    "exact",
  );
  await useOnlyLocalSolanaUsdc(exactTenant.id);
  await createExactEndpoint(exactTenant.id, authCookie);

  const flexTenant = await createTenant(
    organization.id,
    authCookie,
    wallet.id,
    FLEX_TENANT_NAME,
    "flex",
  );
  await useOnlyLocalSolanaUsdc(flexTenant.id);
  await importPublisherOpenApiSpec(flexTenant.id, authCookie);

  // Keep local bootstrap deterministic even if the queue is still starting.
  for (const name of [EXACT_TENANT_NAME, FLEX_TENANT_NAME]) {
    await triggerCertProvisioning(
      nodes.map((node) => node.id),
      toDomainInfo({
        name,
        org_slug: organization.slug,
      }),
    );
  }

  await waitForTenantActive(exactTenant.id);
  await waitForTenantActive(flexTenant.id);

  for (const node of nodes) {
    await syncToNode(node.id);
    await waitForProxyPaymentRequired(node.internalIp, EXACT_PROXY_DOMAIN);
    await waitForProxyPaymentRequired(node.internalIp, FLEX_PROXY_DOMAIN);
  }

  logger.info(
    `Local developer stack ready.
Admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}
Exact proxy node A: http://${EXACT_PROXY_DOMAIN}:${PRIMARY_PROXY_PORT}/v1/chat/completions
Exact proxy node B: http://${EXACT_PROXY_DOMAIN}:${SECONDARY_PROXY_PORT}/v1/chat/completions
Flex proxy node A: http://${FLEX_PROXY_DOMAIN}:${PRIMARY_PROXY_PORT}/v1/chat/completions
Flex proxy node B: http://${FLEX_PROXY_DOMAIN}:${SECONDARY_PROXY_PORT}/v1/chat/completions`,
  );
}

try {
  await main();
} finally {
  await db.destroy();
}
