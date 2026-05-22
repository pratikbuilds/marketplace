import { readFileSync, watchFile } from "fs";
import { serve } from "@hono/node-server";
import { createMultiSiteApp } from "@faremeter/sidecar/app";
import type { CreateAppOpts, MultiSiteConfig } from "@faremeter/sidecar/app";
import { createHTTPFacilitatorHandler } from "@faremeter/middleware";
import { extractSpec } from "@faremeter/middleware-openapi";
import type {
  CaptureResponse,
  FaremeterSpec,
} from "@faremeter/middleware-openapi";
import type { HandlerCapabilities } from "@faremeter/types/pricing";
import { normalizeNetworkId } from "@faremeter/info";

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
  tenantName: string;
  orgSlug: string | null;
};

type SidecarConfig = {
  facilitatorURL?: string;
  sites: Record<string, SiteConfig>;
};

function log(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
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

function buildSites(config: SidecarConfig): MultiSiteConfig {
  const sites: MultiSiteConfig = {};

  if (!config.facilitatorURL) {
    if (Object.keys(config.sites).length > 0) {
      throw new Error("facilitatorURL is required when sites are configured");
    }
    return sites;
  }

  for (const [slug, site] of Object.entries(config.sites)) {
    const rawFaremeterSpec = extractSpec(site.spec);
    const faremeterSpec = normalizeRuntimeSpec(rawFaremeterSpec);
    const capabilities = normalizeRuntimeCapabilities(site.capabilities);
    const x402Handlers = [
      createHTTPFacilitatorHandler(config.facilitatorURL, {
        capabilities,
      }),
    ];

    const opts: CreateAppOpts = {
      spec: faremeterSpec,
      baseURL: site.baseURL,
      x402Handlers,
      // onCapture needs the raw spec so recorded transactions keep the control-plane
      // network name and token-symbol parsing from the original asset key.
      onCapture: buildOnCapture(site, rawFaremeterSpec),
    };

    sites[slug] = opts;
  }

  return sites;
}

const initialConfig = loadConfig();
const initialSites = buildSites(initialConfig);

let current = createMultiSiteApp(initialSites);

function reloadConfig(reason: string): void {
  log("info", `Reloading config (${reason})...`);
  try {
    const newConfig = loadConfig();
    const newSites = buildSites(newConfig);
    current = createMultiSiteApp(newSites);
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
