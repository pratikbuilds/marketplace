import { solana } from "@faremeter/info";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const CONTROL_PLANE_BASE_URL =
  process.env.LOCAL_CONTROL_PLANE_BASE_URL ?? "http://127.0.0.1:11337";
const DISCOVERY_BASE_URL =
  process.env.LOCAL_DISCOVERY_BASE_URL ?? "http://127.0.0.1:11339";
const UI_URL = process.env.LOCAL_UI_URL ?? "http://127.0.0.1:11338";
const PROXY_URL_A =
  process.env.LOCAL_PROXY_URL_A ??
  "http://demo-api.local.proxy.localhost:18080/v1/chat/completions";
const PROXY_HEALTH_URL_A =
  process.env.LOCAL_PROXY_HEALTH_URL_A ??
  "http://demo-api.local.proxy.localhost:18080/health";
const PROXY_URL_B =
  process.env.LOCAL_PROXY_URL_B ??
  "http://demo-api.local.proxy.localhost:18081/v1/chat/completions";
const PROXY_HEALTH_URL_B =
  process.env.LOCAL_PROXY_HEALTH_URL_B ??
  "http://demo-api.local.proxy.localhost:18081/health";
const PROXY_HOST =
  process.env.LOCAL_PROXY_HOST ?? "demo-api.local.proxy.localhost";
const ADMIN_EMAIL =
  process.env.LOCAL_ADMIN_EMAIL ?? "admin@local.faremeter.test";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD ?? "localdev123";
const EXPECTED_DEMO_PRICE = process.env.LOCAL_DEMO_PRICE ?? "1000";
const CHECK_ENDPOINT_PATH = `/v1/local-check/created-${Date.now()}`;

const rawSolanaCluster = process.env.SOLANA_NETWORK ?? "devnet";
if (!solana.isKnownCluster(rawSolanaCluster)) {
  throw new Error(
    `Unsupported SOLANA_NETWORK for local check: ${rawSolanaCluster}`,
  );
}

function getSolanaUsdc(cluster: solana.KnownCluster) {
  const token = solana.lookupKnownSPLToken(cluster, "USDC");
  if (!token) {
    throw new Error(`Couldn't look up USDC on Solana ${cluster}`);
  }
  return token;
}

const SOLANA_CLUSTER = rawSolanaCluster;
const SOLANA_USDC = getSolanaUsdc(SOLANA_CLUSTER);
const SOLANA_NETWORK_IDS = solana.getV1NetworkIds(SOLANA_CLUSTER);
const EXPECTED_SOLANA_NETWORKS = new Set([
  ...SOLANA_NETWORK_IDS,
  solana.normalizeNetworkId(SOLANA_CLUSTER),
]);

type LoginResponse = {
  user: {
    organizations: {
      id: number;
      slug: string;
    }[];
  };
};

type OrganizationTenant = {
  id: number;
  name: string;
  status: string;
  nodes: { id: number }[];
};

type TransactionRecord = {
  id: number;
  endpoint_id?: number | null;
  request_path?: string | null;
};

type EndpointRecord = {
  id: number;
  path: string;
  path_pattern: string;
};

type EarningsAnalytics = {
  total_earned: number;
  current_month_earned: number;
  previous_month_earned: number;
  percent_change: number | null;
  total_transactions: number;
};

type AdminTransactionsResponse = {
  transactions: TransactionRecord[];
  total: number;
};

type PaymentRequirement = {
  network?: unknown;
  asset?: unknown;
  maxAmountRequired?: unknown;
};

function controlPlaneHealthUrl(): string {
  return `${CONTROL_PLANE_BASE_URL}/health`;
}

function discoveryHealthUrl(): string {
  return `${DISCOVERY_BASE_URL}/health`;
}

async function waitFor(url: string, label: string): Promise<void> {
  const timeoutAt = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(url);
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

async function apiJson<T>(
  path: string,
  authCookie: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", authCookie);

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

async function login(): Promise<{
  authCookie: string;
  organizationId: number;
}> {
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
    throw new Error("Login succeeded but auth cookie was not returned");
  }

  const authCookie = rawCookie.split(";")[0];
  if (!authCookie) {
    throw new Error("Could not parse auth cookie from login response");
  }

  const body = (await response.json()) as LoginResponse;
  const organization = body.user.organizations.find(
    (org) => org.slug === "local",
  );
  if (!organization) {
    throw new Error("Local development organization was not found after login");
  }

  return {
    authCookie,
    organizationId: organization.id,
  };
}

async function findDemoTenant(
  organizationId: number,
  authCookie: string,
): Promise<OrganizationTenant> {
  const tenants = await apiJson<OrganizationTenant[]>(
    `/api/organizations/${organizationId}/tenants`,
    authCookie,
  );

  const tenant = tenants.find((item) => item.name === "demo-api");
  if (!tenant) {
    throw new Error("Demo tenant was not found in the local organization");
  }

  if (tenant.status !== "active") {
    throw new Error(`Demo tenant is not active yet (status=${tenant.status})`);
  }

  if (tenant.nodes.length < 2) {
    throw new Error(
      `Demo tenant expected 2 nodes, found ${tenant.nodes.length}`,
    );
  }

  return tenant;
}

async function getTransactionCount(
  tenantId: number,
  authCookie: string,
): Promise<number> {
  const transactions = await apiJson<TransactionRecord[]>(
    `/api/tenants/${tenantId}/transactions`,
    authCookie,
  );
  return transactions.length;
}

async function createFreeSmokeEndpoint(
  tenantId: number,
  authCookie: string,
): Promise<EndpointRecord> {
  const endpoint = await apiJson<EndpointRecord>(
    `/api/tenants/${tenantId}/endpoints`,
    authCookie,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: CHECK_ENDPOINT_PATH,
        price: 0,
        description:
          "Local free check endpoint created through the control plane",
        priority: 10,
        http_method: "POST",
        tags: ["local-check"],
      }),
    },
  );

  if (endpoint.path !== CHECK_ENDPOINT_PATH) {
    throw new Error(`Unexpected local check endpoint path: ${endpoint.path}`);
  }

  return endpoint;
}

async function waitForTransactionCount(
  tenantId: number,
  authCookie: string,
  minimumCount: number,
): Promise<number> {
  const timeoutAt = Date.now() + 60_000;

  while (Date.now() < timeoutAt) {
    const count = await getTransactionCount(tenantId, authCookie);
    if (count >= minimumCount) {
      return count;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Timed out waiting for transactions to reach ${minimumCount} for tenant ${tenantId}`,
  );
}

type ProxyResponse = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

function buildProxyBody(): string {
  return JSON.stringify({
    model: "local-demo",
    messages: [{ role: "user", content: "hello" }],
  });
}

async function proxyRequest(urlString: string): Promise<ProxyResponse> {
  const url = new URL(urlString);
  const body = buildProxyBody();
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<ProxyResponse>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          Host: PROXY_HOST,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => raw,
            json: async () => JSON.parse(raw) as unknown,
          });
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`Proxy request timed out for ${urlString}`));
    });
    req.end(body);
  });
}

async function assertSuccessfulProxyCall(url: string): Promise<unknown> {
  const response = await proxyRequest(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Expected proxy call to succeed for ${url}, got ${response.status}: ${text}`,
    );
  }

  return await response.json();
}

function getAccepts(body: unknown): PaymentRequirement[] {
  if (typeof body !== "object" || body === null || !("accepts" in body)) {
    return [];
  }

  const accepts = body.accepts;
  if (!Array.isArray(accepts)) {
    return [];
  }

  return accepts.filter(
    (item): item is PaymentRequirement =>
      typeof item === "object" && item !== null,
  );
}

async function assertUnpaid(url: string): Promise<void> {
  const response = await proxyRequest(url);
  if (response.status !== 402) {
    throw new Error(
      `Expected unpaid proxy call to return 402 for ${url}, got ${response.status}`,
    );
  }

  const body = await response.json();
  const accepts = getAccepts(body);
  const matching = accepts.find(
    (requirement) =>
      typeof requirement.network === "string" &&
      EXPECTED_SOLANA_NETWORKS.has(requirement.network) &&
      requirement.asset === SOLANA_USDC.address,
  );

  if (!matching) {
    throw new Error(
      `Expected 402 accepts to include ${SOLANA_CLUSTER} USDC ${SOLANA_USDC.address}`,
    );
  }

  if (matching.maxAmountRequired !== EXPECTED_DEMO_PRICE) {
    throw new Error(
      `Expected unpaid proxy to require ${EXPECTED_DEMO_PRICE} atomic USDC, got ${matching.maxAmountRequired}`,
    );
  }
}

function proxyUrlFor(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function main() {
  await waitFor(controlPlaneHealthUrl(), "control-plane");
  await waitFor(discoveryHealthUrl(), "discovery");
  await waitFor(UI_URL, "control-plane-ui");
  await waitFor(PROXY_HEALTH_URL_A, "api-node-a");
  await waitFor(PROXY_HEALTH_URL_B, "api-node-b");

  const { authCookie, organizationId } = await login();
  const tenant = await findDemoTenant(organizationId, authCookie);
  const initialTransactionCount = await getTransactionCount(
    tenant.id,
    authCookie,
  );
  const createdEndpoint = await createFreeSmokeEndpoint(tenant.id, authCookie);
  const createdProxyUrlA = proxyUrlFor(PROXY_URL_A, createdEndpoint.path);
  const createdProxyUrlB = proxyUrlFor(PROXY_URL_B, createdEndpoint.path);

  await assertUnpaid(PROXY_URL_A);
  await assertUnpaid(PROXY_URL_B);
  const createdBodyA = await assertSuccessfulProxyCall(createdProxyUrlA);
  const createdBodyB = await assertSuccessfulProxyCall(createdProxyUrlB);
  const finalTransactionCount = await waitForTransactionCount(
    tenant.id,
    authCookie,
    initialTransactionCount + 2,
  );
  const tenantAnalytics = await apiJson<EarningsAnalytics>(
    `/api/admin/tenants/${tenant.id}/analytics`,
    authCookie,
  );
  if (tenantAnalytics.total_transactions < finalTransactionCount) {
    throw new Error(
      `Expected admin tenant analytics to include at least ${finalTransactionCount} transactions, got ${tenantAnalytics.total_transactions}`,
    );
  }

  const adminTransactions = await apiJson<AdminTransactionsResponse>(
    "/api/admin/transactions?limit=25",
    authCookie,
  );
  if (adminTransactions.total < finalTransactionCount) {
    throw new Error(
      `Expected admin transactions total to include at least ${finalTransactionCount} transactions, found ${adminTransactions.total}`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        organizationId,
        tenantId: tenant.id,
        createdEndpointId: createdEndpoint.id,
        initialTransactionCount,
        finalTransactionCount,
        tenantAnalytics,
        createdNodeA: createdBodyA,
        createdNodeB: createdBodyB,
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
}

await main();
