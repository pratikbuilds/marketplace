import { type } from "arktype";
import { db } from "../db/instance.js";
import { logger } from "../logger.js";
import { buildTenantDomain, toDomainInfo } from "./domain.js";
import { buildTenantGatewaySpecFromData } from "./gateway-spec-builder.js";
import { extractGatewaySpec, generateConfig } from "@faremeter/gateway-nginx";
import { extractSpec } from "@faremeter/middleware-openapi";

const envType = type({
  FACILITATOR_URL: "string > 0",
  "SIDECAR_URL?": "string",
});
const env = envType.assert(process.env);
const FACILITATOR_URL = env.FACILITATOR_URL;
const SIDECAR_URL = env.SIDECAR_URL ?? "http://127.0.0.1:4002";
const PROXY_BASE_PROTOCOL = process.env.PROXY_BASE_PROTOCOL ?? "https";
const PROXY_BASE_PORT = process.env.PROXY_BASE_PORT;

function sanitizeSlugPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveGatewaySlug(tenant: {
  name: string;
  org_slug: string | null;
}): string {
  const name = sanitizeSlugPart(tenant.name);
  if (tenant.org_slug) {
    return `${tenant.org_slug}--${name}`;
  }
  return name;
}

function buildExternalProxyBaseUrl(domain: string): string {
  const port = PROXY_BASE_PORT ? `:${PROXY_BASE_PORT}` : "";
  return `${PROXY_BASE_PROTOCOL}://${domain}${port}`;
}

export async function buildNodeConfig(nodeId: number) {
  const node = await db
    .selectFrom("nodes")
    .selectAll()
    .where("id", "=", nodeId)
    .executeTakeFirst();

  if (!node) {
    logger.warn(`buildNodeConfig: Node ${nodeId} not found`);
    return null;
  }

  const tenants = await db
    .selectFrom("tenants")
    .innerJoin("tenant_nodes", "tenant_nodes.tenant_id", "tenants.id")
    .innerJoin("wallets", "wallets.id", "tenants.wallet_id")
    .select([
      "tenants.id",
      "tenants.name",
      "tenants.backend_url",
      "tenants.wallet_id",
      "tenants.default_scheme",
      "tenants.openapi_spec",
      "tenants.upstream_auth_header",
      "tenants.upstream_auth_value",
      "tenants.org_slug",
      "wallets.wallet_config",
    ])
    .where("tenant_nodes.node_id", "=", nodeId)
    .where("tenants.is_active", "=", true)
    .where("tenants.status", "=", "active")
    .where("wallets.funding_status", "=", "funded")
    .execute();

  const config: Record<string, unknown> = {};
  const gateway: Record<string, unknown> = {};
  const sidecarSites: Record<string, unknown> = {};
  let skippedCollision = 0;
  let skippedSpecFailed = 0;

  for (const tenant of tenants) {
    const endpoints = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("is_active", "=", true)
      .orderBy("priority", "asc")
      .execute();

    const tokenPrices = await db
      .selectFrom("token_prices")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .execute();

    const domainInfo = toDomainInfo(tenant);
    const domain = buildTenantDomain(domainInfo);

    const gatewaySlug = deriveGatewaySlug(tenant);

    if (gateway[gatewaySlug]) {
      logger.error(
        `buildNodeConfig: Gateway slug collision for "${gatewaySlug}" — tenant ${tenant.name} (id=${tenant.id}) collides with an already-processed tenant, skipping`,
      );
      skippedCollision++;
      continue;
    }

    const specResult = buildTenantGatewaySpecFromData({
      tenantId: tenant.id,
      tenantName: tenant.name,
      defaultScheme: tenant.default_scheme,
      openapiSpec: tenant.openapi_spec,
      walletConfig: tenant.wallet_config,
      endpoints: endpoints.map((e) => ({
        id: e.id,
        path: e.path,
        path_pattern: e.path_pattern,
        openapi_source_paths: e.openapi_source_paths,
        price: e.price,
        scheme: e.scheme,
        description: e.description,
        http_method: e.http_method,
      })),
      tokenPrices: tokenPrices.map((tp) => ({
        token_symbol: tp.token_symbol,
        mint_address: tp.mint_address,
        network: tp.network,
        amount: String(tp.amount), // eslint-disable-line @typescript-eslint/no-unnecessary-type-conversion -- runtime type differs from Kysely schema
        decimals: tp.decimals,
        endpoint_id: tp.endpoint_id,
      })),
    });

    if (!specResult) {
      logger.warn(
        `buildNodeConfig: Skipping tenant ${tenant.name} (id=${tenant.id}) - buildTenantGatewaySpecFromData returned null`,
      );
      skippedSpecFailed++;
      continue;
    }

    const { spec, operationKeyToEndpointId } = specResult;
    const parsedSpec = extractGatewaySpec(spec);
    const faremeterSpec = extractSpec(spec);

    const networks = [
      ...new Set(Object.values(faremeterSpec.assets).map((a) => a.chain)),
    ];
    const assets = [
      ...new Set(Object.values(faremeterSpec.assets).map((a) => a.token)),
    ];
    const capabilities = {
      schemes: [tenant.default_scheme ?? "exact"],
      networks,
      assets,
    };

    const extraDirectives: string[] = [];
    if (tenant.upstream_auth_header && tenant.upstream_auth_value) {
      const safeHeaderName = /^[a-zA-Z0-9_-]+$/;
      const unsafeNginxValue = /["\n\r;$\\]/;
      if (!safeHeaderName.test(tenant.upstream_auth_header)) {
        logger.error(
          `buildNodeConfig: tenant ${tenant.name} has invalid upstream_auth_header, skipping auth header injection`,
        );
      } else if (unsafeNginxValue.test(tenant.upstream_auth_value)) {
        logger.error(
          `buildNodeConfig: tenant ${tenant.name} has unsafe characters in upstream_auth_value, skipping auth header injection`,
        );
      } else {
        extraDirectives.push(
          `proxy_set_header ${tenant.upstream_auth_header} "${tenant.upstream_auth_value}";`,
        );
      }
    }

    const { locationsConf, luaFiles, warnings } = generateConfig({
      routes: parsedSpec.routes,
      sidecarURL: SIDECAR_URL,
      upstreamURL: tenant.backend_url,
      sitePrefix: gatewaySlug,
      extraDirectives: extraDirectives.length > 0 ? extraDirectives : undefined,
    });

    for (const warning of warnings) {
      logger.warn(
        "buildNodeConfig: gateway-nginx warning for tenant {tenantName}: {warning}",
        { tenantName: tenant.name, warning },
      );
    }

    const baseURL = buildExternalProxyBaseUrl(domain);

    config[domain] = {
      name: tenant.name,
      proxy_name: tenant.name,
      domain,
      org_slug: tenant.org_slug,
      gateway_slug: gatewaySlug,
      backend_url: tenant.backend_url,
      upstream_auth_header: tenant.upstream_auth_header,
      upstream_auth_value: tenant.upstream_auth_value,
    };

    gateway[gatewaySlug] = {
      spec,
      locationsConf,
      luaFiles: Object.fromEntries(luaFiles),
      warnings,
      sidecarPrefix: gatewaySlug,
      baseURL,
      operationKeyToEndpointId,
      capabilities,
    };

    sidecarSites[gatewaySlug] = {
      spec,
      baseURL,
      capabilities,
      operationKeyToEndpointId,
      tenantName: tenant.name,
      orgSlug: tenant.org_slug,
    };
  }

  const skipParts: string[] = [];
  if (skippedCollision > 0)
    skipParts.push(`${skippedCollision} slug collision`);
  if (skippedSpecFailed > 0) skipParts.push(`${skippedSpecFailed} spec failed`);
  if (skipParts.length > 0) {
    logger.info(
      `buildNodeConfig: Skipped on node ${nodeId}: ${skipParts.join(", ")}`,
    );
  }

  return {
    node_id: node.id,
    node_name: node.name,
    tenant_count: Object.keys(gateway).length,
    config,
    gateway,
    sidecar: {
      facilitatorURL: FACILITATOR_URL,
      sites: sidecarSites,
    },
  };
}

const skipSync =
  process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
const forceDevSync = process.env.DEV_SYNC_ENABLED === "true";

function buildNodeSyncUrl(internalIp: string): string {
  if (internalIp.startsWith("http://") || internalIp.startsWith("https://")) {
    return `${internalIp.replace(/\/$/, "")}/internal/config`;
  }

  if (internalIp.includes(":")) {
    return `http://${internalIp}/internal/config`;
  }

  return `http://${internalIp}:80/internal/config`;
}

export async function syncToNode(nodeId: number) {
  if (skipSync && !forceDevSync) {
    logger.info(`[DEV] syncToNode: Would sync to node ${nodeId} (skipped)`);
    return;
  }

  const node = await db
    .selectFrom("nodes")
    .select(["internal_ip", "status"])
    .where("id", "=", nodeId)
    .executeTakeFirst();

  if (!node) {
    logger.error(`syncToNode: Node ${nodeId} not found`);
    return;
  }

  if (node.status !== "active") {
    logger.info(`syncToNode: Node ${nodeId} is not active, skipping`);
    return;
  }

  const config = await buildNodeConfig(nodeId);
  if (!config) return;

  try {
    const response = await fetch(buildNodeSyncUrl(node.internal_ip), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      logger.error(
        `syncToNode: Failed to push to node ${nodeId}: ${response.status}`,
      );
    } else {
      logger.info(`syncToNode: Pushed config to node ${nodeId}`);
    }
  } catch (err) {
    logger.error(`syncToNode: Error pushing to node ${nodeId}: ${err}`);
  }
}

export async function syncTenantNodes(tenantId: number) {
  const tenant = await db
    .selectFrom("tenants")
    .select("status")
    .where("id", "=", tenantId)
    .executeTakeFirst();

  if (!tenant || tenant.status === "registered") {
    return;
  }

  const tenantNodes = await db
    .selectFrom("tenant_nodes")
    .select("node_id")
    .where("tenant_id", "=", tenantId)
    .execute();

  for (const tn of tenantNodes) {
    syncToNode(tn.node_id).catch((err: unknown) => logger.error(String(err)));
  }
}
