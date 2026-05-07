import { readFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  type Instruction,
  type KeyPairSigner,
  type Signature,
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
} from "@solana/kit";
import { lookupKnownSPLToken } from "@faremeter/info/solana";
import {
  fetchEscrowAccount,
  findPendingSettlementsByEscrow,
  findVaultPda,
  getCloseEscrowInstruction,
  getCloseSessionKeyInstruction,
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRefundInstruction,
  getRegisterSessionKeyInstructionAsync,
  getRevokeSessionKeyInstruction,
} from "@faremeter/flex-solana";
import { createPaymentHandler } from "@faremeter/payment-solana/flex/client";
import { wrap as wrapFetch } from "@faremeter/fetch";
import type { webcrypto } from "node:crypto";

const CONTROL_PLANE_BASE_URL =
  process.env.LOCAL_CONTROL_PLANE_BASE_URL ?? "http://127.0.0.1:11337";
const PROXY_BASE_URL =
  process.env.LOCAL_PROXY_BASE_URL ??
  "http://demo-api.local.proxy.localhost:18080";
const LOCAL_NODE_IDS = (process.env.LOCAL_NODE_IDS ?? "1,2")
  .split(",")
  .map((item) => parseInt(item.trim(), 10))
  .filter(Number.isFinite);
const LOCAL_NODE_CONFIG_URLS = (
  process.env.LOCAL_NODE_CONFIG_URLS ??
  "http://127.0.0.1:18080/internal/config,http://127.0.0.1:18081/internal/config"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ADMIN_EMAIL =
  process.env.LOCAL_ADMIN_EMAIL ?? "admin@local.faremeter.test";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD ?? "localdev123";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? "../keypairs/client-devnet.json";
const FACILITATOR_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR_PATH ?? "../keypairs/facilitator.json";
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const EXPECTED_AMOUNT = process.env.LOCAL_DEMO_PRICE ?? "1000";
const LOG_SYNC_CONFIG = process.env.LOCAL_FLEX_LOG_SYNC_CONFIG === "1";

type SolanaNetwork = "devnet" | "mainnet-beta" | "testnet";

function readNetwork(value: string | undefined): SolanaNetwork {
  if (value === undefined) return "devnet";
  if (value === "devnet" || value === "mainnet-beta" || value === "testnet") {
    return value;
  }
  throw new Error(
    `Unsupported SOLANA_NETWORK ${value}. Expected devnet, mainnet-beta, or testnet.`,
  );
}

const NETWORK = readNetwork(process.env.SOLANA_NETWORK);

const endpointPath = `/v1/local-check/flex-${Date.now()}`;
const targetURL = `${PROXY_BASE_URL}${endpointPath}`;
const rpc = createSolanaRpc(SOLANA_RPC_URL);
const execFile = promisify(execFileCallback);

type LoginResponse = {
  user: { organizations: { id: number; slug: string }[] };
};

type Tenant = {
  id: number;
  name: string;
};

type Endpoint = {
  id: number;
  path: string;
};

type PaymentRequirement = {
  scheme?: unknown;
  asset?: unknown;
  network?: unknown;
  maxAmountRequired?: unknown;
};

type PaymentResponse = {
  success?: unknown;
  transaction?: unknown;
  network?: unknown;
  payer?: unknown;
};

type SyncConfigForLogging = {
  node_id?: unknown;
  node_name?: unknown;
  config?: unknown;
  gateway?: Record<
    string,
    {
      locationsConf?: unknown;
      luaFiles?: unknown;
      capabilities?: unknown;
      operationKeyToEndpointId?: unknown;
      warnings?: unknown;
    }
  >;
  sidecar?: unknown;
};

async function waitFor(url: string, label: string): Promise<void> {
  const timeoutAt = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
  const response = await fetch(`${CONTROL_PLANE_BASE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

async function login() {
  const response = await fetch(`${CONTROL_PLANE_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${text}`);
  }

  const authCookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!authCookie) throw new Error("Login did not return an auth cookie");

  const body = JSON.parse(text) as LoginResponse;
  const organization = body.user.organizations.find(
    (item) => item.slug === "local",
  );
  if (!organization) throw new Error("Local organization not found");

  return { authCookie, organizationId: organization.id };
}

async function createFlexEndpoint(): Promise<{
  authCookie: string;
  tenantId: number;
  endpointId: number;
}> {
  const { authCookie, organizationId } = await login();
  const tenants = await apiJson<Tenant[]>(
    `/api/organizations/${organizationId}/tenants`,
    authCookie,
  );
  const tenant = tenants.find((item) => item.name === "demo-api");
  if (!tenant) throw new Error("demo-api tenant not found");

  const endpoint = await apiJson<Endpoint>(
    `/api/tenants/${tenant.id}/endpoints`,
    authCookie,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: endpointPath,
        price: 1,
        scheme: "flex",
        description: "Docker devnet flex gateway smoke endpoint",
        priority: 1,
        http_method: "POST",
        tags: ["local-check"],
      }),
    },
  );

  return { authCookie, tenantId: tenant.id, endpointId: endpoint.id };
}

async function deleteEndpoint(
  tenantId: number,
  endpointId: number,
  authCookie: string,
) {
  await apiJson(
    `/api/tenants/${tenantId}/endpoints/${endpointId}`,
    authCookie,
    {
      method: "DELETE",
    },
  );
}

async function syncLocalNodes() {
  if (LOCAL_NODE_IDS.length !== LOCAL_NODE_CONFIG_URLS.length) {
    throw new Error(
      `LOCAL_NODE_IDS and LOCAL_NODE_CONFIG_URLS must have the same length, got ${LOCAL_NODE_IDS.length} and ${LOCAL_NODE_CONFIG_URLS.length}`,
    );
  }

  for (const [index, nodeId] of LOCAL_NODE_IDS.entries()) {
    const config = await fetch(
      `${CONTROL_PLANE_BASE_URL}/internal/nodes/${nodeId}/sync`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const text = await config.text();
    if (!config.ok) {
      throw new Error(
        `Failed to build sync config for node ${nodeId}: ${config.status} ${text}`,
      );
    }

    if (LOG_SYNC_CONFIG) {
      logSyncConfig(nodeId, text);
    }

    const configUrl = LOCAL_NODE_CONFIG_URLS[index];
    if (!configUrl) throw new Error(`Missing config URL for node ${nodeId}`);

    const pushed = await fetch(configUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(15_000),
    });
    const pushedText = await pushed.text();
    if (!pushed.ok) {
      throw new Error(
        `Failed to push sync config to ${configUrl}: ${pushed.status} ${pushedText}`,
      );
    }
  }
}

function logSyncConfig(nodeId: number, rawConfig: string) {
  const parsed = JSON.parse(rawConfig) as SyncConfigForLogging;
  const gateway = Object.fromEntries(
    Object.entries(parsed.gateway ?? {}).map(([slug, value]) => [
      slug,
      {
        capabilities: value.capabilities,
        operationKeyToEndpointId: value.operationKeyToEndpointId,
        locationsConf: value.locationsConf,
        luaFiles: value.luaFiles,
        warnings: value.warnings,
      },
    ]),
  );

  process.stderr.write(
    `\n--- sync config for local node ${nodeId} ---\n${JSON.stringify(
      {
        node_id: parsed.node_id,
        node_name: parsed.node_name,
        config: parsed.config,
        gateway,
        sidecar: parsed.sidecar,
      },
      null,
      2,
    )}\n--- end sync config for local node ${nodeId} ---\n`,
  );
}

async function assertFlex402() {
  const timeoutAt = Date.now() + 60_000;
  let lastStatus = 0;
  let lastText = "";

  while (Date.now() < timeoutAt) {
    const response = await fetch(targetURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "flex" }),
      signal: AbortSignal.timeout(15_000),
    });

    lastStatus = response.status;
    lastText = await response.text();

    if (response.status !== 402) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    const body = JSON.parse(lastText) as { accepts?: unknown };
    const accepts = Array.isArray(body.accepts) ? body.accepts : [];
    const flex = accepts.find(
      (item): item is PaymentRequirement =>
        typeof item === "object" &&
        item !== null &&
        (item as PaymentRequirement).scheme === "flex",
    );

    if (!flex) throw new Error("402 response did not include a flex accept");
    if (flex.maxAmountRequired !== EXPECTED_AMOUNT) {
      throw new Error(
        `Expected flex maxAmountRequired ${EXPECTED_AMOUNT}, got ${String(flex.maxAmountRequired)}`,
      );
    }
    return;
  }

  throw new Error(
    `Expected 402 from unpaid flex endpoint, got ${lastStatus}: ${lastText}`,
  );
}

async function assertPaidRouteIsGone() {
  const timeoutAt = Date.now() + 30_000;

  while (Date.now() < timeoutAt) {
    const response = await fetch(targetURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "flex" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status !== 402) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Deleted flex endpoint is still returning 402 after cleanup");
}

async function readSigner(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

async function confirmSignature(sig: Signature) {
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
  await confirmSignature(sig);
  return sig;
}

async function waitSlots(n: number) {
  const target = (await rpc.getSlot().send()) + BigInt(n);
  while ((await rpc.getSlot().send()) < target) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function decodePaymentResponse(raw: string | null): unknown {
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as unknown;
}

function getAuthorizationId(response: unknown): string {
  const paymentResponse = response as PaymentResponse;
  if (
    typeof paymentResponse === "object" &&
    paymentResponse !== null &&
    paymentResponse.success === true &&
    typeof paymentResponse.transaction === "string" &&
    /^\d+$/.test(paymentResponse.transaction)
  ) {
    return paymentResponse.transaction;
  }

  throw new Error(
    `Expected flex payment response transaction to be a numeric authorization id, got ${JSON.stringify(response)}`,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readFacilitatorLogs(): Promise<string> {
  const { stdout, stderr } = await execFile("docker", [
    "compose",
    "logs",
    "--no-color",
    "facilitator",
  ]);
  return `${stdout}\n${stderr}`;
}

async function waitForFacilitatorFlushTransaction(
  authorizationId: string,
): Promise<Signature> {
  const timeoutAt = Date.now() + 90_000;
  const pattern = new RegExp(
    `flushed authorizationId=${escapeRegex(authorizationId)} tx=([1-9A-HJ-NP-Za-km-z]+)`,
  );

  while (Date.now() < timeoutAt) {
    const logs = await readFacilitatorLogs();
    const match = logs.match(pattern);
    const tx = match?.[1];
    if (tx) {
      await confirmSignature(tx as Signature);
      return tx as Signature;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for facilitator to flush authorizationId ${authorizationId}`,
  );
}

async function runFlexPayment() {
  const owner = await readSigner(PAYER_KEYPAIR_PATH);
  const facilitator = await readSigner(FACILITATOR_KEYPAIR_PATH);
  const usdcInfo = lookupKnownSPLToken(NETWORK, "USDC");
  if (!usdcInfo) throw new Error(`Could not look up USDC on ${NETWORK}`);
  const mintAddress = address(usdcInfo.address);

  const { value: tokenAccounts } = await rpc
    .getTokenAccountsByOwner(
      owner.address,
      { mint: mintAddress },
      { encoding: "base64" },
    )
    .send();
  const sourceTokenAccount = tokenAccounts[0]?.pubkey;
  if (!sourceTokenAccount) {
    throw new Error(
      `No ${NETWORK} USDC token account found for ${owner.address}`,
    );
  }

  let escrowAddress: Parameters<typeof fetchEscrowAccount>[1] | null = null;
  let sessionKeyPDA:
    | Parameters<typeof getCloseSessionKeyInstruction>[0]["sessionKeyAccount"]
    | null = null;

  try {
    const createIx = await getCreateEscrowInstructionAsync({
      owner,
      index: Date.now(),
      facilitator: facilitator.address,
      refundTimeoutSlots: 150,
      deadmanTimeoutSlots: 100_000,
      maxSessionKeys: 10,
    });
    await sendInstructions(owner, [createIx]);

    const escrowMeta = createIx.accounts[1];
    if (!escrowMeta) throw new Error("Escrow account meta missing");
    escrowAddress = escrowMeta.address;

    await sendInstructions(owner, [
      await getDepositInstructionAsync({
        depositor: owner,
        escrow: escrowAddress,
        mint: mintAddress,
        source: sourceTokenAccount,
        amount: 50_000,
      }),
    ]);

    const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as webcrypto.CryptoKeyPair;
    const sessionKeyAddress = await getAddressFromPublicKey(keyPair.publicKey);
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowAddress,
      sessionKey: sessionKeyAddress,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 10,
    });
    await sendInstructions(owner, [registerIx]);

    const sessionKeyMeta = registerIx.accounts[2];
    if (!sessionKeyMeta) throw new Error("Session key account meta missing");
    sessionKeyPDA = sessionKeyMeta.address;

    const paymentHandler = createPaymentHandler({
      network: NETWORK,
      escrow: escrowAddress,
      mint: mintAddress,
      sessionKeyPair: keyPair,
      sessionKeyAddress,
      rpc,
    });
    const flexFetch = wrapFetch(fetch, {
      handlers: [paymentHandler],
      retryCount: 0,
    });

    const response = await flexFetch(targetURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "docker-flex", messages: [] }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Paid flex request failed: ${response.status} ${text}`);
    }

    const paymentResponse = decodePaymentResponse(
      response.headers.get("x-payment-response"),
    );
    const authorizationId = getAuthorizationId(paymentResponse);
    const onChainFlushTransaction =
      await waitForFacilitatorFlushTransaction(authorizationId);

    return {
      status: response.status,
      response: JSON.parse(text) as unknown,
      paymentResponse,
      authorizationId,
      onChainFlushTransaction,
      escrow: escrowAddress,
    };
  } finally {
    if (escrowAddress) {
      try {
        await cleanupFlexAccounts({
          owner,
          facilitator,
          escrow: escrowAddress,
          sessionKeyAccount: sessionKeyPDA,
          mint: mintAddress,
          sourceTokenAccount,
        });
      } catch (error) {
        process.stderr.write(
          `Warning: flex escrow cleanup did not complete for ${escrowAddress}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
}

async function cleanupFlexAccounts(args: {
  owner: Awaited<ReturnType<typeof readSigner>>;
  facilitator: Awaited<ReturnType<typeof readSigner>>;
  escrow: NonNullable<Awaited<ReturnType<typeof runFlexPayment>>["escrow"]>;
  sessionKeyAccount:
    | Parameters<typeof getCloseSessionKeyInstruction>[0]["sessionKeyAccount"]
    | null;
  mint: Parameters<typeof findVaultPda>[0]["mint"];
  sourceTokenAccount: Parameters<
    typeof getCloseEscrowInstruction
  >[0]["owner"]["address"];
}) {
  for (let i = 0; i < 20; i++) {
    const pendings = await findPendingSettlementsByEscrow(rpc, args.escrow);
    for (const pending of pendings) {
      await sendInstructions(args.facilitator, [
        getRefundInstruction({
          escrow: args.escrow,
          facilitator: args.facilitator,
          pending: pending.address,
          refundAmount: pending.account.amount,
        }),
      ]);
    }

    const escrow = await fetchEscrowAccount(rpc, args.escrow);
    if (!escrow || escrow.pendingCount === 0n) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const escrowBeforeSessionClose = await fetchEscrowAccount(rpc, args.escrow);
  if (
    args.sessionKeyAccount &&
    escrowBeforeSessionClose &&
    escrowBeforeSessionClose.sessionKeyCount > 0
  ) {
    await sendInstructions(args.owner, [
      getRevokeSessionKeyInstruction({
        owner: args.owner,
        escrow: args.escrow,
        sessionKeyAccount: args.sessionKeyAccount,
      }),
    ]);
    await waitSlots(11);
    await sendInstructions(args.owner, [
      getCloseSessionKeyInstruction({
        owner: args.owner,
        escrow: args.escrow,
        sessionKeyAccount: args.sessionKeyAccount,
      }),
    ]);
  }

  for (let i = 0; i < 20; i++) {
    const escrow = await fetchEscrowAccount(rpc, args.escrow);
    if (!escrow) return;
    if (escrow.pendingCount > 0n || escrow.sessionKeyCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    const [vaultAddress] = await findVaultPda({
      escrow: args.escrow,
      mint: args.mint,
    });
    const baseCloseIx = getCloseEscrowInstruction({
      escrow: args.escrow,
      owner: args.owner,
      facilitator: args.facilitator,
    });
    await sendInstructions(args.owner, [
      {
        ...baseCloseIx,
        accounts: [
          ...baseCloseIx.accounts,
          { address: vaultAddress, role: AccountRole.WRITABLE as const },
          {
            address: args.sourceTokenAccount,
            role: AccountRole.WRITABLE as const,
          },
        ],
      },
    ]);
    return;
  }

  throw new Error(`Escrow cleanup did not complete for ${args.escrow}`);
}

export async function runDockerFlexDevnetCheck() {
  await waitFor(`${CONTROL_PLANE_BASE_URL}/health`, "control-plane");
  await waitFor(`${PROXY_BASE_URL}/health`, "api-node proxy");

  const endpoint = await createFlexEndpoint();
  let payment: Awaited<ReturnType<typeof runFlexPayment>> | undefined;

  try {
    await syncLocalNodes();
    await assertFlex402();
    payment = await runFlexPayment();
  } finally {
    try {
      await deleteEndpoint(
        endpoint.tenantId,
        endpoint.endpointId,
        endpoint.authCookie,
      );
      await syncLocalNodes();
      await assertPaidRouteIsGone();
    } catch (error) {
      process.stderr.write(
        `Warning: temporary endpoint cleanup did not fully verify: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (!payment) throw new Error("Flex payment did not run");

  return {
    status: "ok",
    tenantId: endpoint.tenantId,
    endpointId: endpoint.endpointId,
    path: endpointPath,
    targetURL,
    payment,
  };
}
