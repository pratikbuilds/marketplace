import { readFileSync, watchFile } from "fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHTTPFacilitatorHandler } from "@faremeter/middleware";
import {
  createGatewayHandler,
  extractSpec,
  requestContext,
  responseContext,
} from "@faremeter/middleware-openapi";
import type {
  CaptureResponse,
  FaremeterSpec,
  GatewayHandler,
  GatewayHandlerConfig,
} from "@faremeter/middleware-openapi";
import { isValidationError } from "@faremeter/types";
import type { HandlerCapabilities } from "@faremeter/types/pricing";
import { normalizeNetworkId } from "@faremeter/info";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const CONFIG_PATH =
  process.env.SIDECAR_CONFIG_PATH ?? "/etc/faremeter-sidecar/config.json";
const CONTROL_PLANE_ADDRS_PATH =
  process.env.CONTROL_PLANE_ADDRS_PATH ?? "/etc/nginx/control-plane-addrs.conf";
const CONTROL_PLANE_ADDRS = process.env.CONTROL_PLANE_ADDRS;
const WATCH_CONFIG = process.env.SIDECAR_WATCH_CONFIG === "true";
const PORT = parseInt(process.env.PORT ?? "4002", 10);

type SiteConfig = {
  spec: Record<string, unknown>;
  baseURL: string;
  capabilities: HandlerCapabilities;
  operationKeyToEndpointId: Record<string, number>;
  operationKeyToScheme?: Record<string, string>;
  tenantName: string;
  orgSlug: string | null;
};

type SidecarConfig = {
  facilitatorURL?: string;
  sites: Record<string, SiteConfig>;
};

type PaymentScheme = "exact" | "flex";

type RuntimeSiteConfig = {
  byScheme: Partial<Record<PaymentScheme, GatewayHandler>>;
  legacy?: GatewayHandler;
  operationKeyToScheme: Record<string, PaymentScheme>;
};

type RuntimeSites = Record<string, RuntimeSiteConfig>;
type ParseJSONResult =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

type RequestEnvelope = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

const PAYMENT_SCHEMES = new Set<string>(["exact", "flex"]);

function log(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
}

function isPaymentScheme(scheme: string): scheme is PaymentScheme {
  return PAYMENT_SCHEMES.has(scheme);
}

function requestErrorEnvelope(status: number, error: string): RequestEnvelope {
  return { status, body: { error } };
}

function readControlPlaneAddrs(): string[] {
  if (CONTROL_PLANE_ADDRS) {
    return CONTROL_PLANE_ADDRS.split(",")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }

  const raw = readFileSync(CONTROL_PLANE_ADDRS_PATH, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

let roundRobinIndex = 0;

function pickControlPlaneAddr(addrs: string[]): string {
  const addr = addrs[roundRobinIndex % addrs.length];
  if (!addr) {
    throw new Error("No control plane addresses available");
  }
  roundRobinIndex = (roundRobinIndex + 1) % addrs.length;
  return addr;
}

function toFiniteAmount(raw: string): number {
  if (raw.trim() === "") {
    throw new Error("Empty amount in capture result");
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Non-numeric amount in capture result: "${raw}"`);
  }
  return n;
}

function extractTxHash(
  payment: NonNullable<CaptureResponse["payment"]>,
): string {
  if (payment.protocol === "mpp") {
    return payment.settlement.reference;
  }
  return payment.settlement.transaction;
}

function buildOnCapture(
  site: SiteConfig,
  spec: FaremeterSpec,
): (operationKey: string, result: CaptureResponse) => Promise<void> {
  // Cache addresses at build time; refreshed on SIGHUP via buildSites → buildOnCapture
  const addrs = readControlPlaneAddrs();

  return async (operationKey, result) => {
    if (!result.settled) {
      return;
    }
    if (!result.payment) {
      log(
        "warn",
        `Settled capture for "${operationKey}" has no payment details, skipping transaction recording`,
      );
      return;
    }

    const endpointId = site.operationKeyToEndpointId[operationKey];
    if (endpointId === undefined) {
      log(
        "warn",
        `No endpoint ID found for operation key "${operationKey}", skipping transaction recording`,
      );
      return;
    }

    const [assetKey, amountStr] = Object.entries(result.amount)[0] ?? [];
    if (!assetKey || !amountStr) {
      log(
        "warn",
        `Settled payment for "${operationKey}" has empty amount, skipping transaction recording`,
      );
      return;
    }
    const asset = spec.assets[assetKey];
    if (!asset) {
      log("warn", `Unknown asset "${assetKey}" in capture result, skipping`);
      return;
    }

    const addr = pickControlPlaneAddr(addrs);

    const reqInfo = result.request;
    const forwardedFor =
      reqInfo.headers["x-forwarded-for"] ??
      reqInfo.headers["x-real-ip"] ??
      "unknown";
    const [clientIp = "unknown"] = forwardedFor.split(",");
    const body = {
      ngx_request_id: reqInfo.headers["x-request-id"] ?? crypto.randomUUID(),
      tenant_name: site.tenantName,
      org_slug: site.orgSlug,
      endpoint_id: endpointId,
      amount: toFiniteAmount(amountStr),
      tx_hash: extractTxHash(result.payment),
      network: asset.chain,
      token_symbol: assetKey.slice(asset.chain.length + 1),
      mint_address: asset.token,
      request_path: reqInfo.path,
      client_ip: clientIp.trim(),
      request_method: reqInfo.method,
      metadata: null,
    };

    const response = await fetch(`http://${addr}/internal/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to record transaction: HTTP ${response.status} — ${text}`,
      );
    }
  };
}

function normalizeRuntimeSpec(spec: FaremeterSpec): FaremeterSpec {
  return {
    ...spec,
    assets: Object.fromEntries(
      Object.entries(spec.assets).map(([key, asset]) => [
        key,
        { ...asset, chain: normalizeNetworkId(asset.chain) },
      ]),
    ),
  };
}

function normalizeRuntimeCapabilities(
  capabilities: HandlerCapabilities,
): HandlerCapabilities {
  return {
    ...capabilities,
    networks: capabilities.networks.map((network) =>
      normalizeNetworkId(network),
    ),
  };
}

function parseOperationKeyToScheme(raw: Record<string, string> | undefined): {
  operationKeyToScheme: Record<string, PaymentScheme>;
  hasExplicitMapping: boolean;
} {
  if (raw === undefined) {
    return { operationKeyToScheme: {}, hasExplicitMapping: false };
  }

  const operationKeyToScheme: Record<string, PaymentScheme> = {};
  for (const [operationKey, scheme] of Object.entries(raw)) {
    if (!isPaymentScheme(scheme)) {
      throw new Error(
        `Invalid scheme "${scheme}" for operation "${operationKey}" in sidecar config`,
      );
    }
    operationKeyToScheme[operationKey] = scheme;
  }
  return { operationKeyToScheme, hasExplicitMapping: true };
}

async function parseJSON(request: Request): Promise<ParseJSONResult> {
  try {
    return { ok: true, value: await request.json() };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
}

function resolveHandler(
  site: RuntimeSiteConfig,
  operationKey: string,
): GatewayHandler | null {
  const scheme = site.operationKeyToScheme[operationKey];
  if (scheme) {
    return site.byScheme[scheme] ?? null;
  }
  return site.legacy ?? null;
}

function createSchemeAwareMultiSiteApp(sites: RuntimeSites) {
  const app = new Hono();

  app.post("/sites/:slug/:phase", async (c) => {
    const phase = c.req.param("phase");
    if (phase !== "request" && phase !== "response") {
      return c.text("Not Found", 404);
    }

    const site = sites[c.req.param("slug")];
    if (!site) return c.text("Not Found", 404);

    const parsed = await parseJSON(c.req.raw);
    if (!parsed.ok) {
      log("warn", `Malformed sidecar JSON body: ${parsed.error.message}`);
      if (phase === "response") {
        return c.json({ error: "malformed JSON body" }, 500);
      }
      return c.json(requestErrorEnvelope(400, "malformed JSON body"));
    }

    if (phase === "request") {
      const validated = requestContext(parsed.value);
      if (isValidationError(validated)) {
        return c.json(requestErrorEnvelope(400, validated.summary));
      }

      const handler = resolveHandler(site, validated.operationKey);
      if (!handler) {
        log(
          "error",
          `No payment scheme mapping for operation "${validated.operationKey}"`,
        );
        return c.json(
          requestErrorEnvelope(500, "payment scheme is not configured"),
        );
      }

      try {
        return c.json(await handler.handleRequest(validated));
      } catch (cause) {
        log(
          "error",
          `handleRequest failed for "${validated.operationKey}": ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return c.json(requestErrorEnvelope(500, "internal error"));
      }
    }

    const validated = responseContext(parsed.value);
    if (isValidationError(validated)) {
      log("error", `/response validation failure: ${validated.summary}`);
      return c.json({ error: validated.summary }, 500);
    }

    const handler = resolveHandler(site, validated.operationKey);
    if (!handler) {
      log(
        "error",
        `No payment scheme mapping for operation "${validated.operationKey}"`,
      );
      return c.json({ error: "payment scheme is not configured" }, 422);
    }

    try {
      const result = await handler.handleResponse(validated);
      return c.json(result, result.status as ContentfulStatusCode);
    } catch (cause) {
      log(
        "error",
        `handleResponse failed for "${validated.operationKey}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return c.json(
        { error: cause instanceof Error ? cause.message : "capture failed" },
        422,
      );
    }
  });

  app.onError((err, c) => {
    const path = c.req.path;
    log(
      "error",
      `Unhandled sidecar error on "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
    if (path.endsWith("/response")) {
      return c.json(
        { error: err instanceof Error ? err.message : "internal error" },
        422,
      );
    }
    return c.json(requestErrorEnvelope(500, "internal error"));
  });

  for (const slug of Object.keys(sites)) {
    if (slug.includes("/")) {
      log("warn", `Ignoring invalid site slug containing slash: ${slug}`);
    }
  }

  return { app };
}

function parseSidecarConfig(raw: string): SidecarConfig {
  const parsed: unknown = JSON.parse(raw);
  // The config file is written by a trusted internal process (config-receiver.lua).
  // We rely on structural compatibility rather than a full runtime schema validator.
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Config file must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.sites !== "object" ||
    obj.sites === null ||
    Array.isArray(obj.sites)
  ) {
    throw new Error(
      "Config file is missing required 'sites' field (expected an object)",
    );
  }
  return parsed as SidecarConfig;
}

function loadConfig(): SidecarConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return parseSidecarConfig(raw);
}

function buildSites(config: SidecarConfig): RuntimeSites {
  const sites: RuntimeSites = {};

  if (!config.facilitatorURL) {
    if (Object.keys(config.sites).length > 0) {
      throw new Error("facilitatorURL is required when sites are configured");
    }
    return sites;
  }
  const facilitatorURL = config.facilitatorURL;

  for (const [slug, site] of Object.entries(config.sites)) {
    const rawFaremeterSpec = extractSpec(site.spec);
    const faremeterSpec = normalizeRuntimeSpec(rawFaremeterSpec);
    const capabilities = normalizeRuntimeCapabilities(site.capabilities);
    const createOpts = (
      handlerCapabilities: HandlerCapabilities,
    ): GatewayHandlerConfig => ({
      spec: faremeterSpec,
      baseURL: site.baseURL,
      x402Handlers: [
        createHTTPFacilitatorHandler(facilitatorURL, {
          capabilities: handlerCapabilities,
        }),
      ],
      onCapture: buildOnCapture(site, rawFaremeterSpec),
    });

    const { operationKeyToScheme, hasExplicitMapping } =
      parseOperationKeyToScheme(site.operationKeyToScheme);
    const schemes = [...new Set(Object.values(operationKeyToScheme))];
    sites[slug] = {
      byScheme: Object.fromEntries(
        schemes.map((scheme) => [
          scheme,
          createGatewayHandler(
            createOpts({ ...capabilities, schemes: [scheme] }),
          ),
        ]),
      ),
      ...(hasExplicitMapping
        ? {}
        : { legacy: createGatewayHandler(createOpts(capabilities)) }),
      operationKeyToScheme,
    };
  }

  return sites;
}

const initialConfig = loadConfig();
const initialSites = buildSites(initialConfig);

let current = createSchemeAwareMultiSiteApp(initialSites);

function reloadConfig(reason: string): void {
  log("info", `Reloading config (${reason})...`);
  try {
    const newConfig = loadConfig();
    const newSites = buildSites(newConfig);
    current = createSchemeAwareMultiSiteApp(newSites);
    log("info", "Config reloaded successfully");
  } catch (err) {
    log("error", `Failed to reload config, keeping previous: ${String(err)}`);
  }
}

process.on("SIGHUP", () => reloadConfig("SIGHUP"));

if (WATCH_CONFIG) {
  watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    reloadConfig("config file change");
  });
}

log("info", `Sidecar starting on port ${PORT}`);

serve({
  fetch: (req, env) => current.app.fetch(req, env),
  port: PORT,
});
