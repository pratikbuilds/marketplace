import fs from "fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { webcrypto } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  fetchEscrowAccount,
  findVaultPda,
  getCloseEscrowInstruction,
  getCloseSessionKeyInstruction,
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  getRevokeSessionKeyInstruction,
} from "@faremeter/flex-solana";
import { wrap as wrapFetch } from "@faremeter/fetch";
import { solana } from "@faremeter/info";
import { createPaymentHandler } from "@faremeter/payment-solana/flex/client";

const CONTROL_PLANE_BASE_URL =
  process.env.LOCAL_CONTROL_PLANE_BASE_URL ?? "http://127.0.0.1:11337";
const DISCOVERY_BASE_URL =
  process.env.LOCAL_DISCOVERY_BASE_URL ?? "http://127.0.0.1:11339";
const FLEX_BACKEND_URL =
  process.env.LOCAL_FLEX_BACKEND_URL ?? "http://publisher-mock:3001";
const FLEX_PROXY_URL =
  process.env.LOCAL_FLEX_PROXY_URL ??
  "http://api-node-a/v1/local-check/flex-paid";
const ADMIN_EMAIL =
  process.env.LOCAL_ADMIN_EMAIL ?? "admin@local.faremeter.test";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD ?? "localdev123";
const FACILITATOR_KEYPAIR_PATH =
  process.env.LOCAL_FACILITATOR_SOLANA_KEYPAIR_PATH ??
  "/workspace/marketplace/keypairs/facilitator.json";
const PAYER_KEYPAIR_PATH =
  process.env.LOCAL_FLEX_PAYER_KEYPAIR_PATH ??
  "/workspace/marketplace/keypairs/client-devnet.json";
const FLEX_PRICE = process.env.LOCAL_FLEX_PRICE ?? "1000";
const FLEX_TENANT_NAME = `demo-flex-api-${Date.now()}`;
const FLEX_ENDPOINT_PREFIX =
  process.env.LOCAL_FLEX_ENDPOINT_PREFIX ?? "/v1/local-check/flex-pricing";
const FLEX_PROXY_HOST = `${FLEX_TENANT_NAME}.local.proxy.localhost`;
let currentFlexProxyHost = FLEX_PROXY_HOST;
const EXISTING_FLEX_TENANT_ID = process.env.LOCAL_FLEX_EXISTING_TENANT_ID
  ? Number(process.env.LOCAL_FLEX_EXISTING_TENANT_ID)
  : null;
const DYNAMIC_MODEL = "gpt-4o";
const DYNAMIC_MAX_TOKENS = 20;
const DYNAMIC_MESSAGES = [{ role: "user", content: "hello" }];
const RESPONSE_USAGE = {
  promptTokens: 11,
  completionTokens: 7,
  totalTokens: 18,
};

const rawSolanaCluster = process.env.SOLANA_NETWORK ?? "devnet";
if (!solana.isKnownCluster(rawSolanaCluster)) {
  throw new Error(
    `Unsupported SOLANA_NETWORK for local flex check: ${rawSolanaCluster}`,
  );
}

const SOLANA_CLUSTER = rawSolanaCluster;
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const solanaUsdc = solana.lookupKnownSPLToken(SOLANA_CLUSTER, "USDC");
if (!solanaUsdc) {
  throw new Error(`Couldn't look up USDC on Solana ${SOLANA_CLUSTER}`);
}
const SOLANA_USDC = solanaUsdc;
const [SOLANA_NETWORK] = solana.getV1NetworkIds(SOLANA_CLUSTER);
if (!SOLANA_NETWORK) {
  throw new Error(`Couldn't derive v1 Solana network for ${SOLANA_CLUSTER}`);
}
const EXPECTED_SOLANA_NETWORKS = new Set([
  SOLANA_NETWORK,
  solana.normalizeNetworkId(SOLANA_CLUSTER),
]);

const FLEX_PRICE_ATOMIC = BigInt(FLEX_PRICE);
const DEPOSIT_AMOUNT = Number(FLEX_PRICE_ATOMIC * 250n);
const REFUND_TIMEOUT_SLOTS = 150;
const DEADMAN_TIMEOUT_SLOTS = 100_000;
const MAX_SESSION_KEYS = 10;
const GRACE_PERIOD_SLOTS = 10;

type FlexRpc = Parameters<typeof fetchEscrowAccount>[0] &
  ReturnType<typeof createSolanaRpc>;

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
  wallet_id: number | null;
  nodes: { id: number }[];
};

type CreatedTenant = {
  id: number;
  name: string;
  status: string;
};

type EndpointRecord = {
  id: number;
  path: string;
};

type TransactionRecord = {
  id: number;
  endpoint_id: number | null;
  amount: number;
  tx_hash: string | null;
};

type WalletRecord = {
  id: number;
  funding_status: string;
};

type PaymentRequirement = {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  maxAmountRequired?: unknown;
  amount?: unknown;
};

type PricingRule = {
  match: string;
  authorize?: string;
  capture: string;
};

type FlexPricingScenario = {
  name: string;
  path: string;
  body: Record<string, unknown>;
  rules: PricingRule[];
  expectedRequirementAmount: string;
  expectedCaptureAmount: number;
};

function proxyHostForTenant(tenantName: string): string {
  return `${tenantName}.local.proxy.localhost`;
}

const FLEX_PRICING_SCENARIOS: FlexPricingScenario[] = [
  {
    name: "upfront-fixed-catch-all",
    path: `${FLEX_ENDPOINT_PREFIX}-upfront-fixed`,
    body: { model: DYNAMIC_MODEL },
    rules: [{ match: "$", capture: "12300" }],
    expectedRequirementAmount: "12300",
    expectedCaptureAmount: 12_300,
  },
  {
    name: "upfront-request-field-equals",
    path: `${FLEX_ENDPOINT_PREFIX}-upfront-field`,
    body: { model: DYNAMIC_MODEL, quantity: 4 },
    rules: [
      {
        match: '$[?@.request.body.model == "gpt-4o"]',
        capture: "$.request.body.quantity * 2500",
      },
    ],
    expectedRequirementAmount: "10000",
    expectedCaptureAmount: 10_000,
  },
  {
    name: "upfront-request-size-exists",
    path: `${FLEX_ENDPOINT_PREFIX}-upfront-size`,
    body: {
      metadata: { tier: "pro" },
      payload: "abcdef",
    },
    rules: [
      {
        match: "$[?@.request.body.metadata.tier]",
        capture: "jsonSize($.request.body.payload) * 700",
      },
    ],
    expectedRequirementAmount: String(JSON.stringify("abcdef").length * 700),
    expectedCaptureAmount: JSON.stringify("abcdef").length * 700,
  },
  {
    name: "after-response-regex",
    path: `${FLEX_ENDPOINT_PREFIX}-after-response-regex`,
    body: {
      model: "claude-sonnet-4",
      max_tokens: DYNAMIC_MAX_TOKENS,
      messages: DYNAMIC_MESSAGES,
    },
    rules: [
      {
        match: '$[?match(@.request.body.model, "claude-sonnet.*")]',
        authorize:
          "(jsonSize($.request.body.messages) * 1200 / 4 + coalesce($.request.body.max_tokens, 1024) * 6000) * 125 / 100",
        capture:
          "$.response.body.usage.prompt_tokens * 1200 + $.response.body.usage.completion_tokens * 6000",
      },
    ],
    expectedRequirementAmount: String(
      Math.ceil(
        ((JSON.stringify(DYNAMIC_MESSAGES).length * 1200) / 4 +
          DYNAMIC_MAX_TOKENS * 6000) *
          1.25,
      ),
    ),
    expectedCaptureAmount:
      RESPONSE_USAGE.promptTokens * 1200 +
      RESPONSE_USAGE.completionTokens * 6000,
  },
  {
    name: "after-response-catch-all-coalesce",
    path: `${FLEX_ENDPOINT_PREFIX}-after-response-catch-all`,
    body: {
      model: "other-model",
      messages: DYNAMIC_MESSAGES,
    },
    rules: [
      {
        match: "$",
        authorize:
          "(jsonSize($.request.body.messages) / 4 * 10 + coalesce($.request.body.max_tokens, 1024) * 40) * 120 / 100",
        capture: "$.response.body.usage.total_tokens * 2000",
      },
    ],
    expectedRequirementAmount: String(
      Math.ceil(
        ((JSON.stringify(DYNAMIC_MESSAGES).length / 4) * 10 + 1024 * 40) * 1.2,
      ),
    ),
    expectedCaptureAmount: RESPONSE_USAGE.totalTokens * 2000,
  },
];

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
      if (response.ok) return;
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

  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
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

async function listTenants(
  organizationId: number,
  authCookie: string,
): Promise<OrganizationTenant[]> {
  return await apiJson<OrganizationTenant[]>(
    `/api/organizations/${organizationId}/tenants`,
    authCookie,
  );
}

async function findDemoWalletId(
  organizationId: number,
  authCookie: string,
): Promise<number> {
  const tenants = await listTenants(organizationId, authCookie);
  const demo = tenants.find((tenant) => tenant.name === "demo-api");
  if (!demo?.wallet_id) {
    throw new Error("Could not find the seeded demo-api wallet");
  }
  return demo.wallet_id;
}

async function assertWalletFunded(
  walletId: number,
  authCookie: string,
): Promise<void> {
  const wallet = await apiJson<WalletRecord>(
    `/api/wallets/${walletId}`,
    authCookie,
  );
  if (wallet.funding_status !== "funded") {
    throw new Error(
      `Flex smoke wallet must be funded, got ${wallet.funding_status}`,
    );
  }
}

async function createFlexTenant(
  organizationId: number,
  authCookie: string,
  walletId: number,
): Promise<CreatedTenant> {
  return await apiJson<CreatedTenant>(
    `/api/organizations/${organizationId}/tenants`,
    authCookie,
    {
      method: "POST",
      body: JSON.stringify({
        name: FLEX_TENANT_NAME,
        backend_url: FLEX_BACKEND_URL,
        wallet_id: walletId,
        default_price: Number(FLEX_PRICE_ATOMIC),
        default_scheme: "flex",
      }),
    },
  );
}

async function createFlexTokenPrice(
  tenantId: number,
  authCookie: string,
): Promise<void> {
  const response = await fetch(
    `${CONTROL_PLANE_BASE_URL}/api/tenants/${tenantId}/token-prices`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        token_symbol: "USDC",
        mint_address: SOLANA_USDC.address,
        network: SOLANA_NETWORK,
        amount: Number(FLEX_PRICE_ATOMIC),
        decimals: 6,
      }),
    },
  );

  if (response.status === 409) {
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `POST /api/tenants/${tenantId}/token-prices failed: ${response.status} ${text}`,
    );
  }
}

function buildDynamicPricingSpec(recipient: Address): Record<string, unknown> {
  const paths = Object.fromEntries(
    FLEX_PRICING_SCENARIOS.map((scenario) => [
      scenario.path,
      {
        post: {
          summary: `Flex pricing scenario ${scenario.name}`,
          "x-faremeter-pricing": {
            rules: [{ match: "$", capture: "1" }],
          },
        },
      },
    ]),
  );

  return {
    openapi: "3.0.3",
    info: {
      title: "Local Dynamic Flex API",
      version: "1.0.0",
    },
    "x-faremeter-assets": {
      "usdc-sol": {
        chain: solana.normalizeNetworkId(SOLANA_CLUSTER),
        token: SOLANA_USDC.address,
        decimals: 6,
        recipient,
      },
    },
    "x-faremeter-pricing": {
      rates: {
        "usdc-sol": 1,
      },
    },
    paths,
  };
}

async function waitForTenantActive(
  organizationId: number,
  tenantId: number,
  authCookie: string,
): Promise<OrganizationTenant> {
  const timeoutAt = Date.now() + 90_000;

  while (Date.now() < timeoutAt) {
    const tenants = await listTenants(organizationId, authCookie);
    const tenant = tenants.find((item) => item.id === tenantId);
    if (tenant?.status === "active" && tenant.nodes.length > 0) {
      return tenant;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for Flex tenant ${tenantId} to activate`);
}

async function importDynamicFlexEndpoint(
  tenantId: number,
  authCookie: string,
  recipient: Address,
): Promise<Map<string, EndpointRecord>> {
  await apiJson(`/api/tenants/${tenantId}/openapi/import`, authCookie, {
    method: "POST",
    body: JSON.stringify({
      spec: buildDynamicPricingSpec(recipient),
    }),
  });

  return await findScenarioEndpoints(tenantId, authCookie);
}

async function findScenarioEndpoints(
  tenantId: number,
  authCookie: string,
): Promise<Map<string, EndpointRecord>> {
  const endpoints = await apiJson<EndpointRecord[]>(
    `/api/tenants/${tenantId}/endpoints`,
    authCookie,
  );
  const byPath = new Map<string, EndpointRecord>();
  for (const scenario of FLEX_PRICING_SCENARIOS) {
    const endpoint = endpoints.find((item) => item.path === scenario.path);
    if (!endpoint) {
      throw new Error(
        `Flex endpoint was not found for scenario: ${scenario.path}`,
      );
    }

    if (endpoint.path !== scenario.path) {
      throw new Error(`Unexpected Flex endpoint path: ${endpoint.path}`);
    }

    byPath.set(scenario.path, endpoint);
  }

  return byPath;
}

async function updatePricingRules(
  tenantId: number,
  endpoint: EndpointRecord,
  authCookie: string,
  rules: PricingRule[],
): Promise<void> {
  await apiJson(
    `/api/tenants/${tenantId}/endpoints/${endpoint.id}/pricing-rules`,
    authCookie,
    {
      method: "PUT",
      body: JSON.stringify({ rules }),
    },
  );
}

async function getTransactions(
  tenantId: number,
  authCookie: string,
): Promise<TransactionRecord[]> {
  return apiJson<TransactionRecord[]>(
    `/api/tenants/${tenantId}/transactions`,
    authCookie,
  );
}

async function waitForPaidEndpointTransaction(
  tenantId: number,
  endpointId: number,
  authCookie: string,
  expectedAmount: number,
): Promise<TransactionRecord> {
  const timeoutAt = Date.now() + 90_000;

  while (Date.now() < timeoutAt) {
    const transaction = (await getTransactions(tenantId, authCookie)).find(
      (item) =>
        item.endpoint_id === endpointId &&
        item.amount === expectedAmount &&
        typeof item.tx_hash === "string" &&
        item.tx_hash.length > 0,
    );
    if (transaction) {
      return transaction;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out waiting for paid Flex transaction recording");
}

function proxyUrlFor(path: string): string {
  const url = new URL(FLEX_PROXY_URL);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildProxyBody(scenario: FlexPricingScenario): string {
  return JSON.stringify(scenario.body);
}

function responseHeaders(
  rawHeaders: Record<string, string | string[] | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

function requestBodyToString(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "utf8",
    );
  }
  throw new Error("local flex check only supports string-compatible bodies");
}

async function proxyFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input.toString());
  const body = requestBodyToString(init.body);
  const headers = new Headers(init.headers);
  headers.set("Host", currentFlexProxyHost);

  if (body !== null) {
    headers.set("Content-Length", Buffer.byteLength(body).toString());
  }

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve(
            new Response(raw, {
              status: res.statusCode ?? 0,
              headers: responseHeaders(res.headers),
            }),
          );
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Proxy request timed out for ${url.toString()}`));
    });

    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
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

async function waitForFlexPaymentRequired(
  url: string,
  scenario: FlexPricingScenario,
): Promise<void> {
  const timeoutAt = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < timeoutAt) {
    try {
      const response = await proxyFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildProxyBody(scenario),
      });

      if (response.status === 402) {
        const body = await response.json();
        const matching = getAccepts(body).find((requirement) => {
          const amount =
            requirement.maxAmountRequired ?? requirement.amount ?? null;
          return (
            requirement.scheme === "flex" &&
            typeof requirement.network === "string" &&
            EXPECTED_SOLANA_NETWORKS.has(requirement.network) &&
            requirement.asset === SOLANA_USDC.address &&
            amount === scenario.expectedRequirementAmount
          );
        });

        if (matching) return;
        lastError = new Error(
          `402 did not include expected Flex requirement: ${JSON.stringify(
            body,
          )}`,
        );
      } else {
        lastError = new Error(`Expected 402, got ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out waiting for Flex payment requirement", {
    cause: lastError,
  });
}

function loadKeypair(path: string): Uint8Array {
  return Uint8Array.from(
    JSON.parse(fs.readFileSync(path, "utf-8")) as number[],
  );
}

async function loadSigner(path: string): Promise<KeyPairSigner> {
  return await createKeyPairSignerFromBytes(loadKeypair(path));
}

async function confirmSignature(rpc: FlexRpc, sig: Signature) {
  for (let i = 0; i < 60; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    const status = statuses[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Transaction confirmation timeout");
}

async function sendInstructions(
  rpc: FlexRpc,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signedTx);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, sig);
}

async function waitSlots(rpc: FlexRpc, n: number): Promise<void> {
  const target = (await rpc.getSlot().send()) + BigInt(n);
  while ((await rpc.getSlot().send()) < target) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function waitForNoPendingSettlements(
  rpc: FlexRpc,
  escrowAddress: Address,
): Promise<boolean> {
  const timeoutAt = Date.now() + 150_000;

  while (Date.now() < timeoutAt) {
    const escrow = await fetchEscrowAccount(rpc, escrowAddress);
    if (!escrow || escrow.pendingCount === 0n) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return false;
}

async function createFlexEscrow() {
  const rpc = createSolanaRpc(SOLANA_RPC_URL) as unknown as FlexRpc;
  const owner = await loadSigner(PAYER_KEYPAIR_PATH);
  const facilitator = await loadSigner(FACILITATOR_KEYPAIR_PATH);
  const mintAddress = address(SOLANA_USDC.address);

  const { value: tokenAccounts } = await rpc
    .getTokenAccountsByOwner(
      owner.address,
      { mint: mintAddress },
      { encoding: "base64" },
    )
    .send();

  const firstAccount = tokenAccounts[0];
  if (!firstAccount) {
    throw new Error(
      "No devnet USDC token account found for the Flex payer. " +
        "Fund LOCAL_FLEX_PAYER_KEYPAIR_PATH before running local-flex-check.",
    );
  }
  const sourceTokenAccount = firstAccount.pubkey;

  const createIx = await getCreateEscrowInstructionAsync({
    owner,
    index: Date.now(),
    facilitator: facilitator.address,
    refundTimeoutSlots: REFUND_TIMEOUT_SLOTS,
    deadmanTimeoutSlots: DEADMAN_TIMEOUT_SLOTS,
    maxSessionKeys: MAX_SESSION_KEYS,
  });
  await sendInstructions(rpc, owner, [createIx]);

  const escrowMeta = createIx.accounts[1];
  if (!escrowMeta) throw new Error("Escrow account meta missing");
  const escrowAddress = escrowMeta.address;

  const depositIx = await getDepositInstructionAsync({
    depositor: owner,
    escrow: escrowAddress,
    mint: mintAddress,
    source: sourceTokenAccount,
    amount: DEPOSIT_AMOUNT,
  });
  await sendInstructions(rpc, owner, [depositIx]);

  const sessionKeyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const sessionKeyAddress = await getAddressFromPublicKey(
    sessionKeyPair.publicKey,
  );

  const registerIx = await getRegisterSessionKeyInstructionAsync({
    owner,
    escrow: escrowAddress,
    sessionKey: sessionKeyAddress,
    expiresAtSlot: null,
    revocationGracePeriodSlots: GRACE_PERIOD_SLOTS,
  });
  await sendInstructions(rpc, owner, [registerIx]);

  const sessionKeyAccountMeta = registerIx.accounts[2];
  if (!sessionKeyAccountMeta)
    throw new Error("Session key account meta missing");

  return {
    rpc,
    owner,
    facilitator,
    mintAddress,
    sourceTokenAccount,
    escrowAddress,
    sessionKeyPair,
    sessionKeyAddress,
    sessionKeyPDA: sessionKeyAccountMeta.address,
  };
}

async function cleanupFlexEscrow(args: {
  rpc: FlexRpc;
  owner: KeyPairSigner;
  facilitator: KeyPairSigner;
  mintAddress: Address;
  sourceTokenAccount: Address;
  escrowAddress: Address;
  sessionKeyPDA: Address;
}): Promise<void> {
  const revokeIx = getRevokeSessionKeyInstruction({
    owner: args.owner,
    escrow: args.escrowAddress,
    sessionKeyAccount: args.sessionKeyPDA,
  });
  await sendInstructions(args.rpc, args.owner, [revokeIx]);

  await waitSlots(args.rpc, GRACE_PERIOD_SLOTS + 1);

  const closeSessionKeyIx = getCloseSessionKeyInstruction({
    owner: args.owner,
    escrow: args.escrowAddress,
    sessionKeyAccount: args.sessionKeyPDA,
  });
  await sendInstructions(args.rpc, args.owner, [closeSessionKeyIx]);

  const noPendingSettlements = await waitForNoPendingSettlements(
    args.rpc,
    args.escrowAddress,
  );
  if (!noPendingSettlements) {
    process.stderr.write(
      `Skipping Flex escrow close for ${args.escrowAddress}: pending settlements still exist\n`,
    );
    return;
  }

  const [vaultAddress] = await findVaultPda({
    escrow: args.escrowAddress,
    mint: args.mintAddress,
  });

  const baseCloseIx = getCloseEscrowInstruction({
    escrow: args.escrowAddress,
    owner: args.owner,
    facilitator: args.facilitator,
  });
  const closeEscrowIx = {
    ...baseCloseIx,
    accounts: [
      ...baseCloseIx.accounts,
      { address: vaultAddress, role: AccountRole.WRITABLE as const },
      {
        address: args.sourceTokenAccount,
        role: AccountRole.WRITABLE as const,
      },
    ],
  };
  await sendInstructions(args.rpc, args.owner, [closeEscrowIx]);
}

async function main() {
  await waitFor(controlPlaneHealthUrl(), "control-plane");
  await waitFor(discoveryHealthUrl(), "discovery");

  const { authCookie, organizationId } = await login();

  const tenant = EXISTING_FLEX_TENANT_ID
    ? await waitForTenantActive(
        organizationId,
        EXISTING_FLEX_TENANT_ID,
        authCookie,
      )
    : await (async () => {
        const walletId = await findDemoWalletId(organizationId, authCookie);
        await assertWalletFunded(walletId, authCookie);
        return await createFlexTenant(organizationId, authCookie, walletId);
      })();
  if (EXISTING_FLEX_TENANT_ID) {
    if (!tenant.wallet_id) {
      throw new Error(
        `Existing Flex tenant ${tenant.id} must have a funded wallet attached`,
      );
    }
    await assertWalletFunded(tenant.wallet_id, authCookie);
  }
  if (!EXISTING_FLEX_TENANT_ID) {
    await waitForTenantActive(organizationId, tenant.id, authCookie);
    await createFlexTokenPrice(tenant.id, authCookie);
  }
  currentFlexProxyHost = proxyHostForTenant(tenant.name);

  const endpointsByPath = EXISTING_FLEX_TENANT_ID
    ? await findScenarioEndpoints(tenant.id, authCookie)
    : await (async () => {
        const facilitator = await loadSigner(FACILITATOR_KEYPAIR_PATH);
        const importedEndpoints = await importDynamicFlexEndpoint(
          tenant.id,
          authCookie,
          facilitator.address,
        );
        for (const scenario of FLEX_PRICING_SCENARIOS) {
          const endpoint = importedEndpoints.get(scenario.path);
          if (!endpoint) {
            throw new Error(`Missing imported endpoint for ${scenario.path}`);
          }
          await updatePricingRules(
            tenant.id,
            endpoint,
            authCookie,
            scenario.rules,
          );
        }
        return importedEndpoints;
      })();

  const initialTransactionCount = (await getTransactions(tenant.id, authCookie))
    .length;
  const flexEscrow = await createFlexEscrow();

  try {
    const handler = createPaymentHandler({
      network: SOLANA_CLUSTER,
      escrow: flexEscrow.escrowAddress,
      mint: flexEscrow.mintAddress,
      sessionKeyPair: flexEscrow.sessionKeyPair,
      sessionKeyAddress: flexEscrow.sessionKeyAddress,
      rpc: flexEscrow.rpc,
    });
    const fetchWithPayer = wrapFetch(proxyFetch as typeof fetch, {
      handlers: [handler],
      retryCount: 3,
      initialRetryDelay: 500,
    });

    const scenarioResults: {
      name: string;
      endpointId: number;
      expectedRequirementAmount: string;
      expectedCaptureAmount: number;
      paidTransactionId: number;
      paidTransactionHash: string | null;
    }[] = [];

    for (const scenario of FLEX_PRICING_SCENARIOS) {
      const endpoint = endpointsByPath.get(scenario.path);
      if (!endpoint) {
        throw new Error(`Missing imported endpoint for ${scenario.path}`);
      }

      const proxyUrl = proxyUrlFor(endpoint.path);
      await waitForFlexPaymentRequired(proxyUrl, scenario);

      const paidResponse = await fetchWithPayer(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildProxyBody(scenario),
      });

      if (!paidResponse.ok) {
        const text = await paidResponse.text();
        throw new Error(
          `Expected paid Flex proxy call for ${scenario.name} to succeed, got ${paidResponse.status}: ${text}`,
        );
      }

      const paidTransaction = await waitForPaidEndpointTransaction(
        tenant.id,
        endpoint.id,
        authCookie,
        scenario.expectedCaptureAmount,
      );

      scenarioResults.push({
        name: scenario.name,
        endpointId: endpoint.id,
        expectedRequirementAmount: scenario.expectedRequirementAmount,
        expectedCaptureAmount: scenario.expectedCaptureAmount,
        paidTransactionId: paidTransaction.id,
        paidTransactionHash: paidTransaction.tx_hash,
      });
    }
    const finalTransactionCount = (await getTransactions(tenant.id, authCookie))
      .length;

    process.stdout.write(
      JSON.stringify(
        {
          status: "ok",
          organizationId,
          tenantId: tenant.id,
          tenantName: tenant.name,
          scenarioCount: scenarioResults.length,
          initialTransactionCount,
          finalTransactionCount,
          scenarios: scenarioResults,
          proxyHost: currentFlexProxyHost,
          escrow: flexEscrow.escrowAddress,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
  } finally {
    await cleanupFlexEscrow(flexEscrow);
  }
}

await main();
