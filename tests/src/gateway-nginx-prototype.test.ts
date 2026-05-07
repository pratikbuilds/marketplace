import t from "tap";
import { $ } from "zx/core";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { configureApp } from "@faremeter/logs";
import { extractSpec } from "@faremeter/middleware-openapi";
import type { CaptureResponse } from "@faremeter/middleware-openapi";
import type { CreateTestFacilitatorHandlerOpts } from "@faremeter/test-harness";
import {
  createTestFacilitatorHandler,
  createTestPaymentHandler,
  createTestMPPHandler,
  createTestMPPPaymentHandler,
} from "@faremeter/test-harness";
import { createApp } from "@faremeter/sidecar/app";
import { wrap } from "@faremeter/fetch";
import { client } from "@faremeter/types";
import { normalizeNetworkId } from "@faremeter/info";
import type { PaymentHandler } from "@faremeter/types/client";
import type { FacilitatorHandler } from "@faremeter/types/facilitator";
import type {
  x402PaymentPayload,
  x402PaymentRequirements,
  x402SettleResponse,
  x402VerifyResponse,
} from "@faremeter/types/x402v2";

$.verbose = false;

const metaDir = import.meta.dirname;
if (!metaDir) throw new Error("import.meta.dirname is not available");
const MARKETPLACE_ROOT = resolve(metaDir, "../..");
const FAREMETER_ROOT = resolve(MARKETPLACE_ROOT, "../faremeter");
const SIDECAR_PORT = 4012;
const UPSTREAM_PORT = 4110;
const NGINX_PORT = 8090;
const NGINX_BASE = `http://127.0.0.1:${NGINX_PORT}`;
const TMP_DIR = join(MARKETPLACE_ROOT, "tmp", "gateway-nginx-prototype-test");
const FLEX_SCHEME = "flex";
const FLEX_NETWORK = "test-local";
const FLEX_ASSET = "TEST";

if (!existsSync(FAREMETER_ROOT)) {
  throw new Error(
    `faremeter SDK checkout not found at ${FAREMETER_ROOT} — ` +
      `this test requires a sibling checkout of faremeter/faremeter`,
  );
}

// -- OpenResty resolution --

function resolveOpenResty(): string | null {
  const override = process.env.FAREMETER_OPENRESTY_BIN;
  if (override) {
    return existsSync(override) ? override : null;
  }

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, "openresty");
    if (existsSync(candidate)) return candidate;
  }

  const fallbacks = [
    "/opt/homebrew/bin/openresty",
    "/usr/local/bin/openresty",
    "/usr/local/openresty/bin/openresty",
    "/usr/bin/openresty",
  ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const OPENRESTY_BIN = resolveOpenResty();

if (!OPENRESTY_BIN) {
  t.comment(
    "openresty not found, skipping gateway-nginx prototype integration tests",
  );
  process.exit(0);
}

const opmBin = join(resolve(OPENRESTY_BIN, ".."), "opm");
const opmResult =
  await $`${opmBin} list 2>/dev/null | grep lua-resty-http`.nothrow();
if (opmResult.exitCode !== 0) {
  t.comment(
    "lua-resty-http not found (opm install ledgetech/lua-resty-http), skipping",
  );
  process.exit(0);
}

// -- Tenant config and OpenAPI conversion --

type EndpointConfig = {
  id: number;
  path: string;
  price: string;
  scheme: string;
  priority: number;
};

type TenantConfig = {
  name: string;
  endpoints: EndpointConfig[];
};

const tenantConfig: TenantConfig = {
  name: "test-api",
  endpoints: [
    {
      id: 1,
      path: "/v1/chat/completions",
      price: "500",
      scheme: "exact",
      priority: 10,
    },
    {
      id: 2,
      path: "/v1/images/{size}",
      price: "200",
      scheme: "exact",
      priority: 20,
    },
    {
      id: 4,
      path: "/v1/flex/completions",
      price: "700",
      scheme: "flex",
      priority: 30,
    },
    { id: 3, path: "/health", price: "0", scheme: "free", priority: 5 },
  ],
};

function tenantConfigToOpenAPIDoc(
  config: TenantConfig,
): Record<string, unknown> {
  const pricedEndpoints = config.endpoints.filter(
    (ep) => ep.scheme !== "free" && ep.price !== "0",
  );

  const sorted = [...pricedEndpoints].sort((a, b) => a.priority - b.priority);

  const paths: Record<string, unknown> = {};
  for (const ep of sorted) {
    paths[ep.path] = {
      post: {
        summary: `Marketplace endpoint ${ep.id}`,
        "x-faremeter-pricing": {
          rules: [{ match: "$", authorize: ep.price, capture: ep.price }],
        },
        responses: { "200": { description: "OK" } },
      },
    };
  }

  return {
    openapi: "3.0.0",
    info: { title: config.name, version: "1.0.0" },
    "x-faremeter-assets": {
      usdc: {
        chain: "test-local",
        token: "TEST",
        decimals: 6,
        recipient: "test-receiver",
      },
    },
    "x-faremeter-pricing": { rates: { usdc: 1 } },
    paths,
  };
}

// -- Health check --

async function waitForHealth(url: string): Promise<void> {
  const timeoutMs = 30_000;
  const maxDelay = 1_000;
  let delay = 50;
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, maxDelay);
  }

  throw new Error(`timed out waiting for ${url} after ${timeoutMs}ms`, {
    cause: lastError,
  });
}

// -- Nginx config generation --

async function generateNginxConfig(
  outputDir: string,
  specPath: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const cliPath = join(FAREMETER_ROOT, "packages/gateway-nginx/src/cli.ts");
  await $`pnpm tsx ${cliPath} \
    --spec ${specPath} \
    --sidecar http://127.0.0.1:${SIDECAR_PORT} \
    --upstream http://127.0.0.1:${UPSTREAM_PORT} \
    --output ${outputDir}`;

  const locations = await readFile(join(outputDir, "locations.conf"), "utf-8");

  const pidPath = join(outputDir, "nginx.pid");
  const errorLogPath = join(outputDir, "error.log");
  const luaPath = join(outputDir, "lua");

  const indentedLocations = locations
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : "    " + line))
    .join("\n");

  const conf = [
    `daemon off;`,
    `pid ${pidPath};`,
    `error_log ${errorLogPath} info;`,
    "",
    "worker_processes auto;",
    "",
    "events {",
    "  worker_connections 1024;",
    "}",
    "",
    "http {",
    `  lua_package_path "${luaPath}/?.lua;;";`,
    "  lua_shared_dict fm_capture_buffer 10m;",
    "  lua_max_pending_timers 4096;",
    "  lua_max_running_timers 1024;",
    "",
    "  server {",
    `    listen ${NGINX_PORT};`,
    "",
    indentedLocations,
    "",
    `    location / {`,
    `      proxy_pass http://127.0.0.1:${UPSTREAM_PORT};`,
    `      proxy_set_header Host $host;`,
    `      proxy_set_header X-Real-IP $remote_addr;`,
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  const confPath = join(outputDir, "nginx.conf");
  await writeFile(confPath, conf);
  return confPath;
}

// -- Mock upstream --

function createMockUpstream(): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", (c) =>
    c.json({
      id: "chatcmpl-marketplace-001",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
    }),
  );

  app.post("/v1/images/:size", (c) =>
    c.json({
      data: [{ url: "https://example.com/image.png" }],
      size: c.req.param("size"),
    }),
  );

  app.post("/v1/flex/completions", (c) =>
    c.json({
      id: "chatcmpl-flex-001",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Hello flex" } }],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}

// -- Callbacks and waiters --

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PaymentRecord = {
  requirementsAmount: string;
  network: string;
  scheme: string;
};
type TestFlexPaymentPayload = {
  testId: string;
  amount: string;
  timestamp: number;
};

type Callbacks = {
  x402VerifyCount: number;
  x402VerifyRecords: PaymentRecord[];
  x402SettleCount: number;
  x402SettleRecords: PaymentRecord[];
  mppSettleCount: number;
  captures: Map<string, CaptureResponse>;
  awaitX402Settle(): Promise<void>;
  awaitCapture(operationKey: string): Promise<void>;
  reset(): void;
};

type VerifyCallback = NonNullable<CreateTestFacilitatorHandlerOpts["onVerify"]>;
type SettleCallback = NonNullable<CreateTestFacilitatorHandlerOpts["onSettle"]>;

function createCallbacks(): {
  cb: Callbacks;
  onX402Verify: VerifyCallback;
  onX402Settle: SettleCallback;
  onMPPSettle: (credential: unknown) => void;
  onCapture: (key: string, result: CaptureResponse) => void;
} {
  let settleWaiter: Waiter | null = null;
  const captureWaiters = new Map<string, Waiter>();

  const cb: Callbacks = {
    x402VerifyCount: 0,
    x402VerifyRecords: [],
    x402SettleCount: 0,
    x402SettleRecords: [],
    mppSettleCount: 0,
    captures: new Map(),

    awaitX402Settle() {
      if (cb.x402SettleCount > 0 && cb.captures.size > 0)
        return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("x402 settle timeout")),
          5000,
        );
        settleWaiter = { resolve, reject, timer };
      });
    },

    awaitCapture(operationKey: string) {
      if (cb.captures.has(operationKey)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`capture timeout: ${operationKey}`)),
          5000,
        );
        captureWaiters.set(operationKey, { resolve, reject, timer });
      });
    },

    reset() {
      cb.x402VerifyCount = 0;
      cb.x402SettleCount = 0;
      cb.mppSettleCount = 0;
      cb.x402SettleRecords = [];
      cb.x402VerifyRecords = [];
      cb.captures.clear();
      if (settleWaiter) {
        clearTimeout(settleWaiter.timer);
        settleWaiter.reject(new Error("cancelled by reset()"));
        settleWaiter = null;
      }
      for (const [key, waiter] of captureWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`awaitCapture(${key}) cancelled by reset()`));
      }
      captureWaiters.clear();
    },
  };

  return {
    cb,
    onX402Verify: (requirements) => {
      cb.x402VerifyCount++;
      cb.x402VerifyRecords.push({
        requirementsAmount: requirements.amount,
        network: requirements.network,
        scheme: requirements.scheme,
      });
    },
    onX402Settle: (requirements) => {
      cb.x402SettleCount++;
      cb.x402SettleRecords.push({
        requirementsAmount: requirements.amount,
        network: requirements.network,
        scheme: requirements.scheme,
      });
      if (cb.x402SettleCount > 0 && cb.captures.size > 0 && settleWaiter) {
        clearTimeout(settleWaiter.timer);
        settleWaiter.resolve();
        settleWaiter = null;
      }
    },
    onMPPSettle: () => {
      cb.mppSettleCount++;
    },
    onCapture: (key, result) => {
      cb.captures.set(key, result);
      if (cb.x402SettleCount > 0 && cb.captures.size > 0 && settleWaiter) {
        clearTimeout(settleWaiter.timer);
        settleWaiter.resolve();
        settleWaiter = null;
      }
      const waiter = captureWaiters.get(key);
      if (waiter) {
        captureWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    },
  };
}

function requireRecord(records: PaymentRecord[], label: string): PaymentRecord {
  const record = records[0];
  if (!record) throw new Error(`no ${label} record found`);
  return record;
}

function requireCapture(cb: Callbacks, operationKey: string): CaptureResponse {
  const cap = cb.captures.get(operationKey);
  if (!cap) throw new Error(`no capture recorded for ${operationKey}`);
  return cap;
}

function isFlexRequirement(requirement: {
  scheme: string;
  network: string;
}): boolean {
  return (
    requirement.scheme.toLowerCase() === FLEX_SCHEME &&
    requirement.network.toLowerCase() === FLEX_NETWORK
  );
}

function isFlexPayload(raw: unknown): raw is TestFlexPaymentPayload {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.testId === "string" &&
    typeof obj.amount === "string" &&
    typeof obj.timestamp === "number"
  );
}

function createTestFlexPaymentHandler(): PaymentHandler {
  return async (_context, accepts) =>
    accepts.filter(isFlexRequirement).map((requirements) => ({
      requirements,
      exec: async () => ({
        payload: {
          testId: `flex-${Date.now()}`,
          amount: requirements.amount,
          timestamp: Date.now(),
        },
      }),
    }));
}

function createTestFlexFacilitatorHandler(opts: {
  payTo: string;
  onVerify: VerifyCallback;
  onSettle: SettleCallback;
}): FacilitatorHandler {
  const getRequirements = async ({
    accepts,
  }: {
    accepts: x402PaymentRequirements[];
  }): Promise<x402PaymentRequirements[]> =>
    accepts.filter(isFlexRequirement).map((requirement) => ({
      ...requirement,
      asset: requirement.asset || FLEX_ASSET,
      payTo: requirement.payTo || opts.payTo,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds ?? 300,
    }));

  function validate(
    requirements: x402PaymentRequirements,
    payment: x402PaymentPayload,
  ): TestFlexPaymentPayload | string {
    if (!isFlexRequirement(requirements)) {
      return "Not a flex requirement";
    }
    if (!isFlexPayload(payment.payload)) {
      return "Invalid flex test payload";
    }
    if (payment.payload.amount !== requirements.amount) {
      return "Amount mismatch";
    }
    if (requirements.payTo.toLowerCase() !== opts.payTo.toLowerCase()) {
      return "Payment to wrong address";
    }
    return payment.payload;
  }

  return {
    capabilities: {
      schemes: [FLEX_SCHEME],
      networks: [FLEX_NETWORK],
      assets: [FLEX_ASSET],
    },
    getSupported: () => [
      Promise.resolve({
        x402Version: 2,
        scheme: FLEX_SCHEME,
        network: FLEX_NETWORK,
      }),
    ],
    getRequirements,
    handleVerify: async (
      requirements,
      payment,
    ): Promise<x402VerifyResponse | null> => {
      const result = validate(requirements, payment);
      if (typeof result === "string") {
        return isFlexRequirement(requirements)
          ? { isValid: false, invalidReason: result }
          : null;
      }
      opts.onVerify(requirements, payment, result);
      return { isValid: true, payer: "test-flex-payer" };
    },
    handleSettle: async (
      requirements,
      payment,
    ): Promise<x402SettleResponse | null> => {
      const result = validate(requirements, payment);
      if (typeof result === "string") {
        return isFlexRequirement(requirements)
          ? {
              success: false,
              errorReason: result,
              transaction: "",
              network: requirements.network,
              payer: "",
            }
          : null;
      }
      opts.onSettle(requirements, payment, result);
      return {
        success: true,
        transaction: `test-flex-tx-${result.testId}`,
        network: FLEX_NETWORK,
        payer: "test-flex-payer",
      };
    },
  };
}

function getAccepts(body: unknown): x402PaymentRequirements[] {
  if (typeof body !== "object" || body === null || !("accepts" in body)) {
    return [];
  }
  const accepts = body.accepts;
  if (!Array.isArray(accepts)) {
    return [];
  }
  return accepts.filter(
    (item): item is x402PaymentRequirements =>
      typeof item === "object" && item !== null,
  );
}

// -- Test suite --

await t.test("gateway-nginx marketplace prototype", async (t) => {
  const nginxOutputDir = join(TMP_DIR, "nginx");
  const specPath = join(TMP_DIR, "openapi.json");

  await configureApp();

  const { cb, onX402Verify, onX402Settle, onMPPSettle, onCapture } =
    createCallbacks();

  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });

  const specDoc = tenantConfigToOpenAPIDoc(tenantConfig);
  await writeFile(specPath, JSON.stringify(specDoc, null, 2));

  const confPath = await generateNginxConfig(nginxOutputDir, specPath);

  const upstreamApp = createMockUpstream();
  const upstreamServer = serve({
    fetch: upstreamApp.fetch,
    port: UPSTREAM_PORT,
  });

  const spec = extractSpec(specDoc);
  const { app: sidecarApp } = createApp({
    spec,
    baseURL: NGINX_BASE,
    supportedVersions: { x402v1: true, x402v2: true },
    x402Handlers: [
      createTestFacilitatorHandler({
        payTo: "test-receiver",
        amountPolicy: (settle, signed) => settle <= signed,
        onVerify: onX402Verify,
        onSettle: onX402Settle,
      }),
      createTestFlexFacilitatorHandler({
        payTo: "test-receiver",
        onVerify: onX402Verify,
        onSettle: onX402Settle,
      }),
    ],
    mppMethodHandlers: [createTestMPPHandler({ onSettle: onMPPSettle })],
    onCapture,
  });
  const sidecarServer = serve({ fetch: sidecarApp.fetch, port: SIDECAR_PORT });

  await waitForHealth(`http://127.0.0.1:${UPSTREAM_PORT}/health`);

  const nginx = $`${OPENRESTY_BIN} -c ${confPath}`;
  const nginxExit = nginx.then(
    () => {
      throw new Error("openresty exited before becoming healthy");
    },
    (cause: unknown) => {
      throw new Error(`openresty exited unexpectedly: ${String(cause)}`);
    },
  );

  await Promise.race([waitForHealth(`${NGINX_BASE}/health`), nginxExit]);
  nginxExit.catch(() => {
    // Swallow the rejection after the race — nginx exit is handled by teardown.
  });

  t.teardown(async () => {
    const pidPath = join(nginxOutputDir, "nginx.pid");
    if (existsSync(pidPath)) {
      await $`kill $(cat ${pidPath})`.nothrow();
    }
    void nginx.nothrow(true);
    await nginx.kill().catch(() => {
      // expected if already stopped
    });
    sidecarServer.close();
    upstreamServer.close();
  });

  const x402Fetch = wrap(fetch, {
    handlers: [
      client.adaptPaymentHandlerV1ToV2(
        createTestPaymentHandler(),
        normalizeNetworkId,
      ),
    ],
    retryCount: 0,
  });

  const mppFetch = wrap(fetch, {
    handlers: [],
    mppHandlers: [createTestMPPPaymentHandler()],
    retryCount: 0,
  });

  const flexFetch = wrap(fetch, {
    handlers: [createTestFlexPaymentHandler()],
    retryCount: 0,
  });

  await t.test("paid endpoint without payment returns 402", async (t) => {
    cb.reset();
    const res = await fetch(`${NGINX_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-3.5", messages: [] }),
    });
    t.equal(res.status, 402);
    const body = (await res.json()) as { accepts?: unknown };
    t.ok(body.accepts !== undefined, "402 body must include accepts");
    t.end();
  });

  await t.test(
    "paid endpoint: verify at access, settle at log, correct capture",
    async (t) => {
      cb.reset();
      const res = await x402Fetch(`${NGINX_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-3.5", messages: [] }),
      });

      t.equal(res.status, 200);
      t.ok(cb.x402VerifyCount > 0, "verify must fire at access time");
      t.equal(cb.x402VerifyRecords.length, 1);
      const vr = requireRecord(cb.x402VerifyRecords, "verify");
      t.equal(
        vr.requirementsAmount,
        "500",
        "verified amount must equal the endpoint price",
      );
      t.equal(
        vr.network,
        "test-local",
        "verify must target the correct network",
      );
      t.equal(cb.x402SettleCount, 0, "settle must not fire before log phase");

      const body = (await res.json()) as { object: string };
      t.equal(body.object, "chat.completion");

      await cb.awaitX402Settle();
      t.ok(cb.x402SettleCount > 0, "settle must fire in log phase");
      t.equal(cb.x402SettleRecords.length, 1);
      const sr = requireRecord(cb.x402SettleRecords, "settle");
      t.equal(
        sr.requirementsAmount,
        "500",
        "settled amount must equal the endpoint price",
      );
      t.equal(
        sr.network,
        "test-local",
        "settle must target the correct network",
      );

      const cap = requireCapture(cb, "POST /v1/chat/completions");
      t.equal(cap.settled, true, "settlement must have succeeded");
      t.equal(
        cap.amount.usdc,
        "500",
        "capture amount must equal endpoint price",
      );
      t.equal(
        cap.request.method,
        "POST",
        "capture must include request method",
      );
      t.equal(
        cap.request.path,
        "/v1/chat/completions",
        "capture must include request path",
      );
      t.ok(
        cap.request.headers["x-request-id"],
        "capture must include nginx request ID",
      );
      t.end();
    },
  );

  await t.test(
    "parameterized paid endpoint without payment returns 402",
    async (t) => {
      cb.reset();
      const res = await fetch(`${NGINX_BASE}/v1/images/large`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      });
      t.equal(res.status, 402);
      const body = (await res.json()) as { accepts?: unknown };
      t.ok(body.accepts !== undefined, "402 body must include accepts");
      t.end();
    },
  );

  await t.test(
    "parameterized paid endpoint: verify at access, settle at log",
    async (t) => {
      cb.reset();
      const res = await x402Fetch(`${NGINX_BASE}/v1/images/large`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      });

      t.equal(res.status, 200);
      t.ok(cb.x402VerifyCount > 0, "verify must fire at access time");
      t.equal(cb.x402VerifyRecords.length, 1);
      const vr = requireRecord(cb.x402VerifyRecords, "verify");
      t.equal(
        vr.requirementsAmount,
        "200",
        "verified amount must equal the images endpoint price",
      );
      t.equal(
        vr.network,
        "test-local",
        "verify must target the correct network",
      );
      t.equal(cb.x402SettleCount, 0, "settle must not fire before log phase");

      const body = (await res.json()) as { data: unknown[] };
      t.ok(Array.isArray(body.data));

      await cb.awaitX402Settle();
      t.ok(cb.x402SettleCount > 0, "settle must fire in log phase");
      t.equal(cb.x402SettleRecords.length, 1);
      const sr = requireRecord(cb.x402SettleRecords, "settle");
      t.equal(
        sr.requirementsAmount,
        "200",
        "settled amount must equal the images endpoint price",
      );
      t.equal(
        sr.network,
        "test-local",
        "settle must target the correct network",
      );

      const cap = requireCapture(cb, "POST /v1/images/{size}");
      t.equal(cap.settled, true, "settlement must have succeeded");
      t.equal(
        cap.amount.usdc,
        "200",
        "capture amount must equal endpoint price",
      );
      t.equal(
        cap.request.method,
        "POST",
        "capture must include request method",
      );
      t.equal(
        cap.request.path,
        "/v1/images/large",
        "capture must include the concrete request path",
      );
      t.ok(
        cap.request.headers["x-request-id"],
        "capture must include nginx request ID",
      );
      t.end();
    },
  );

  await t.test(
    "free /health endpoint is served directly by nginx",
    async (t) => {
      const res = await fetch(`${NGINX_BASE}/health`);
      t.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      t.equal(body.status, "ok");
      t.end();
    },
  );

  await t.test("flex endpoint without payment returns flex 402", async (t) => {
    cb.reset();
    const res = await fetch(`${NGINX_BASE}/v1/flex/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flex-demo", messages: [] }),
    });
    t.equal(res.status, 402);
    const accepts = getAccepts(await res.json());
    t.ok(
      accepts.some((requirement) => requirement.scheme === FLEX_SCHEME),
      "402 accepts must include flex",
    );
    t.end();
  });

  await t.test("flex endpoint verifies and settles as flex", async (t) => {
    cb.reset();
    const res = await flexFetch(`${NGINX_BASE}/v1/flex/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flex-demo", messages: [] }),
    });

    t.equal(res.status, 200);
    t.equal(cb.x402VerifyRecords.length, 1);
    const vr = requireRecord(cb.x402VerifyRecords, "flex verify");
    t.equal(vr.scheme, FLEX_SCHEME, "verify must use flex scheme");
    t.equal(vr.requirementsAmount, "700");
    t.equal(vr.network, FLEX_NETWORK);
    t.equal(cb.x402SettleCount, 0, "settle must not fire before log phase");

    const body = (await res.json()) as { object: string };
    t.equal(body.object, "chat.completion");

    await cb.awaitX402Settle();
    t.equal(cb.x402SettleRecords.length, 1);
    const sr = requireRecord(cb.x402SettleRecords, "flex settle");
    t.equal(sr.scheme, FLEX_SCHEME, "settle must use flex scheme");
    t.equal(sr.requirementsAmount, "700");
    t.equal(sr.network, FLEX_NETWORK);

    const cap = requireCapture(cb, "POST /v1/flex/completions");
    t.equal(cap.settled, true, "flex settlement must succeed");
    t.equal(cap.amount.usdc, "700");
    t.equal(cap.request.method, "POST");
    t.equal(cap.request.path, "/v1/flex/completions");
    t.ok(cap.request.headers["x-request-id"]);
    t.end();
  });

  // -- MPP payment path stays isolated from x402 handlers --

  await t.test("MPP charge: records MPP capture without x402", async (t) => {
    cb.reset();
    const res = await mppFetch(`${NGINX_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-3.5", messages: [] }),
    });
    t.equal(res.status, 200);
    t.equal(cb.x402VerifyCount, 0, "x402 verify must not fire for MPP payment");
    t.equal(cb.x402SettleCount, 0, "x402 settle must not fire for MPP payment");

    const body = (await res.json()) as { object: string };
    t.equal(body.object, "chat.completion");

    await cb.awaitCapture("POST /v1/chat/completions");
    const cap = requireCapture(cb, "POST /v1/chat/completions");
    t.equal(cap.payment?.protocol, "mpp", "capture must record MPP payment");
    t.equal(cap.settled, true, "capture must show successful settlement");
    t.equal(
      cap.amount.usdc,
      "500",
      "capture amount must equal the endpoint price",
    );
    t.equal(
      cap.request.method,
      "POST",
      "MPP capture must include request method",
    );
    t.equal(
      cap.request.path,
      "/v1/chat/completions",
      "MPP capture must include request path",
    );
    t.ok(
      cap.request.headers["x-request-id"],
      "MPP capture must include nginx request ID",
    );
    t.end();
  });

  t.end();
});
