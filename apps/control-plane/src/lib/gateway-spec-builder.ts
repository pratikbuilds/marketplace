import { type } from "arktype";
import { db } from "../db/instance.js";
import { logger } from "../logger.js";
import { endpointPathToOpenApiPath } from "./openapi-sync.js";
import {
  getOpenApiSpec,
  getPricingRulesFromObject,
  isRecord,
} from "./pricing-rules.js";

const WalletEntry = type({ "address?": "string" });

const GatewayWalletConfig = type({
  "solana?": { "mainnet-beta?": WalletEntry, "devnet?": WalletEntry },
  "evm?": {
    "base?": WalletEntry,
    "polygon?": WalletEntry,
    "monad?": WalletEntry,
  },
});

type GatewayWalletConfig = typeof GatewayWalletConfig.infer;

// Maps token_prices.network values to the nested wallet_config path.
// Must stay in sync with CreateTokenPriceSchema's allowed network values.
const NETWORK_PATH: Record<string, [keyof GatewayWalletConfig, string]> = {
  "solana-mainnet-beta": ["solana", "mainnet-beta"],
  "solana-devnet": ["solana", "devnet"],
  base: ["evm", "base"],
  polygon: ["evm", "polygon"],
  "eip155:137": ["evm", "polygon"],
  "eip155:143": ["evm", "monad"],
};

function resolveWalletAddress(
  walletConfig: GatewayWalletConfig,
  network: string,
): string | undefined {
  const path = NETWORK_PATH[network];
  if (!path) {
    throw new Error(
      `resolveWalletAddress: unrecognized network "${network}" — NETWORK_PATH and CreateTokenPriceSchema are out of sync`,
    );
  }
  const [chain, sub] = path;
  const chainObj = walletConfig[chain];
  if (!chainObj) return undefined;
  const entry = (chainObj as Record<string, { address?: string } | undefined>)[
    sub
  ];
  return entry?.address;
}

export type GatewaySpecResult = {
  spec: Record<string, unknown>;
  warnings: string[];
  operationKeyToEndpointId: Record<string, number>;
  operationKeyToScheme: Record<string, "exact" | "flex">;
};

type TokenPriceRow = {
  token_symbol: string;
  mint_address: string;
  network: string;
  amount: string;
  decimals: number;
  endpoint_id: number | null;
  payout_splits?: unknown;
};

type PayoutSplit = {
  recipient: string;
  bps: number;
};

type EndpointRow = {
  id: number;
  path: string | null;
  path_pattern: string;
  openapi_source_paths: string[] | null;
  price: number | null;
  scheme: string | null;
  description: string | null;
  http_method: string;
};

export type GatewaySpecInput = {
  tenantId: number;
  tenantName: string;
  defaultScheme?: string | null;
  openapiSpec?: unknown;
  walletConfig: unknown;
  endpoints: EndpointRow[];
  tokenPrices: TokenPriceRow[];
};

function parseImportedSpec(raw: unknown): Record<string, unknown> | null {
  return getOpenApiSpec(raw);
}

function getRecordProperty(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj?.[key];
  return isRecord(value) ? value : undefined;
}

function getImportedPricingRules(
  obj: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] | null {
  return getPricingRulesFromObject(obj) as Record<string, unknown>[] | null;
}

function getImportedAssets(
  importedSpec: Record<string, unknown> | null,
): Record<string, unknown> {
  const assets = getRecordProperty(importedSpec, "x-faremeter-assets");
  return assets ? structuredClone(assets) : {};
}

function parsePayoutSplits(value: unknown): PayoutSplit[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    return parsePayoutSplits(JSON.parse(value));
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const splits: PayoutSplit[] = [];
  for (const split of value) {
    if (
      !isRecord(split) ||
      typeof split.recipient !== "string" ||
      typeof split.bps !== "number"
    ) {
      return null;
    }
    splits.push({ recipient: split.recipient, bps: split.bps });
  }
  return splits;
}

function buildAsset(
  tp: TokenPriceRow,
  recipient: string,
): Record<string, unknown> {
  const asset: Record<string, unknown> = {
    chain: tp.network,
    token: tp.mint_address,
    decimals: tp.decimals,
    recipient,
  };
  const splits = parsePayoutSplits(tp.payout_splits);
  if (splits) {
    asset.splits = splits;
  }
  return asset;
}

function getImportedOperationPricingRules(
  importedSpec: Record<string, unknown> | null,
  path: string,
  method: string,
): Record<string, unknown>[] | null {
  const importedPaths = getRecordProperty(importedSpec, "paths");
  const importedPath = getRecordProperty(importedPaths, path);
  const importedOperation = getRecordProperty(importedPath, method);

  return (
    getImportedPricingRules(importedOperation) ??
    getImportedPricingRules(importedPath) ??
    getImportedPricingRules(importedSpec)
  );
}

export function buildTenantGatewaySpecFromData(
  input: GatewaySpecInput,
): GatewaySpecResult | null {
  const walletConfigParsed = GatewayWalletConfig(input.walletConfig);
  if (walletConfigParsed instanceof type.errors) {
    logger.warn(
      `buildTenantGatewaySpec: tenant ${input.tenantId} has invalid wallet_config: ${walletConfigParsed.summary}`,
    );
    return null;
  }

  const walletConfig: GatewayWalletConfig = walletConfigParsed;
  const { endpoints, tokenPrices } = input;
  const warnings: string[] = [];
  const importedSpec = parseImportedSpec(input.openapiSpec);
  const assets: Record<string, unknown> = getImportedAssets(importedSpec);

  // Build x-faremeter-assets from tenant-level token prices (endpoint_id IS NULL)
  const tenantLevelPrices = tokenPrices.filter((tp) => tp.endpoint_id === null);

  for (const tp of tenantLevelPrices) {
    const alias = `${tp.network}-${tp.token_symbol}`;
    if (assets[alias]) continue;

    const recipient = resolveWalletAddress(walletConfig, tp.network);

    if (!recipient) {
      warnings.push(
        `No wallet address configured for network "${tp.network}" (required for asset "${alias}")`,
      );
      continue;
    }

    assets[alias] = buildAsset(tp, recipient);
  }

  // Build a lookup map for endpoint-level token prices, keyed by endpoint_id
  const endpointPriceMap = new Map<number, TokenPriceRow[]>();
  for (const tp of tokenPrices) {
    if (tp.endpoint_id === null) continue;
    const existing = endpointPriceMap.get(tp.endpoint_id);
    if (existing) {
      existing.push(tp);
    } else {
      endpointPriceMap.set(tp.endpoint_id, [tp]);
    }
  }

  const paths: Record<string, unknown> = {};
  const operationKeyToEndpointId: Record<string, number> = {};
  const operationKeyToScheme: Record<string, "exact" | "flex"> = {};

  for (const endpoint of endpoints) {
    // Keep legacy "free" rows excluded while new code treats price 0 as
    // endpoint payment status rather than as a payment scheme.
    if (endpoint.price === 0 || endpoint.scheme === "free") continue;

    const sourcePaths = endpoint.openapi_source_paths;
    const resolvedPaths: string[] = [];

    if (sourcePaths && sourcePaths.length > 0) {
      resolvedPaths.push(...sourcePaths);
    } else {
      const converted = endpointPathToOpenApiPath(
        endpoint.path,
        endpoint.path_pattern,
      );
      if (!converted) {
        warnings.push(
          `Cannot convert path pattern "${endpoint.path_pattern}" to OpenAPI path for endpoint ${endpoint.id} — skipping`,
        );
        continue;
      }
      resolvedPaths.push(converted);
    }

    // Determine pricing rules for this endpoint
    const endpointScheme = getEndpointScheme(endpoint, input.defaultScheme);
    const epPrices = endpointPriceMap.get(endpoint.id) ?? [];
    const pricingResult = buildPricingRules(
      endpoint,
      epPrices,
      tenantLevelPrices,
      assets,
      walletConfig,
    );
    warnings.push(...pricingResult.warnings);
    Object.assign(assets, pricingResult.additionalAssets);

    const pricingExtension =
      pricingResult.rules.length > 0
        ? { "x-faremeter-pricing": { rules: pricingResult.rules } }
        : {};

    // ANY expands to standard content-bearing methods. HEAD is served by
    // nginx natively from the GET handler, and OPTIONS (CORS preflight)
    // should not require payment. Tenants can still price HEAD or OPTIONS
    // individually by setting http_method explicitly on the endpoint.
    const methods =
      endpoint.http_method === "ANY"
        ? (["GET", "POST", "PUT", "DELETE", "PATCH"] as const)
        : ([endpoint.http_method] as const);

    for (const method of methods) {
      const methodLower = method.toLowerCase();

      for (const openApiPath of resolvedPaths) {
        const operationKey = `${method} ${openApiPath}`;

        // Endpoints are ordered by priority ASC (lower number = higher priority).
        // First endpoint to claim a method+path wins; duplicates are skipped.
        if (operationKeyToEndpointId[operationKey] !== undefined) {
          warnings.push(
            `Duplicate operation "${operationKey}" from endpoint ${endpoint.id} — already claimed by endpoint ${operationKeyToEndpointId[operationKey]}, skipping`,
          );
          continue;
        }

        const existing =
          (paths[openApiPath] as Record<string, unknown> | undefined) ?? {};
        const importedPricingRules = getImportedOperationPricingRules(
          importedSpec,
          openApiPath,
          methodLower,
        );
        const operationPricingExtension =
          importedPricingRules !== null
            ? { "x-faremeter-pricing": { rules: importedPricingRules } }
            : pricingExtension;
        const operationScheme =
          importedPricingRules !== null &&
          pricingRulesRequireFlex(importedPricingRules)
            ? "flex"
            : endpointScheme;

        existing[methodLower] = {
          summary: endpoint.description ?? `Endpoint: ${openApiPath}`,
          responses: { "200": { description: "Successful response" } },
          ...operationPricingExtension,
        };
        paths[openApiPath] = existing;

        operationKeyToEndpointId[operationKey] = endpoint.id;
        operationKeyToScheme[operationKey] = operationScheme;
      }
    }
  }

  // Rules use absolute atomic amounts as capture values, so rates are 1:1 —
  // the evaluator multiplies coefficient * rate, and with rate=1 the result
  // equals the capture value directly.
  const importedRootPricing = getRecordProperty(
    importedSpec,
    "x-faremeter-pricing",
  );
  const importedRates = getRecordProperty(importedRootPricing, "rates");
  const rates: Record<string, unknown> = importedRates
    ? structuredClone(importedRates)
    : {};
  for (const alias of Object.keys(assets)) {
    if (rates[alias] === undefined) {
      rates[alias] = 1;
    }
  }

  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: {
      title: input.tenantName,
      version: "1.0.0",
    },
    "x-faremeter-assets": assets,
    "x-faremeter-pricing": {
      ...(importedRootPricing ?? {}),
      rates,
    },
    paths,
  };

  return { spec, warnings, operationKeyToEndpointId, operationKeyToScheme };
}

function getEndpointScheme(
  endpoint: EndpointRow,
  defaultScheme: string | null | undefined,
): "exact" | "flex" {
  const scheme = endpoint.scheme ?? defaultScheme ?? "exact";
  return scheme === "flex" ? "flex" : "exact";
}

function pricingRulesRequireFlex(rules: Record<string, unknown>[]): boolean {
  return rules.some(
    (rule) => typeof rule.authorize === "string" && rule.authorize.length > 0,
  );
}

export async function buildTenantGatewaySpec(
  tenantId: number,
): Promise<GatewaySpecResult | null> {
  const tenantRow = await db
    .selectFrom("tenants")
    .innerJoin("wallets", "wallets.id", "tenants.wallet_id")
    .select([
      "tenants.id",
      "tenants.name",
      "tenants.default_scheme",
      "tenants.openapi_spec",
      "wallets.wallet_config",
    ])
    .where("tenants.id", "=", tenantId)
    .executeTakeFirst();

  if (!tenantRow) {
    logger.debug(`buildTenantGatewaySpec: tenant ${tenantId} not found`);
    return null;
  }

  const [endpoints, tokenPrices] = await Promise.all([
    db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("is_active", "=", true)
      .orderBy("priority", "asc")
      .execute(),
    db
      .selectFrom("token_prices")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .execute(),
  ]);

  return buildTenantGatewaySpecFromData({
    tenantId,
    tenantName: tenantRow.name,
    defaultScheme: tenantRow.default_scheme,
    openapiSpec: tenantRow.openapi_spec,
    walletConfig: tenantRow.wallet_config,
    endpoints,
    tokenPrices: tokenPrices.map((tp) => ({
      ...tp,
      // SQLite returns integer columns as numbers; coerce to string to match
      // the production Postgres schema where amount is bigint (text).
      amount: String(tp.amount), // eslint-disable-line @typescript-eslint/no-unnecessary-type-conversion -- runtime type differs from Kysely schema
    })),
  });
}

type PricingRulesResult = {
  rules: Record<string, unknown>[];
  warnings: string[];
  additionalAssets: Record<string, unknown>;
};

function buildPricingRules(
  endpoint: EndpointRow,
  endpointPrices: TokenPriceRow[],
  tenantPrices: TokenPriceRow[],
  existingAssets: Record<string, unknown>,
  walletConfig: GatewayWalletConfig,
): PricingRulesResult {
  const result: PricingRulesResult = {
    rules: [],
    warnings: [],
    additionalAssets: {},
  };

  if (endpointPrices.length > 0) {
    // Endpoint-specific token prices take precedence
    for (const tp of endpointPrices) {
      const alias = `${tp.network}-${tp.token_symbol}`;
      if (!existingAssets[alias]) {
        // The caller merges additionalAssets into existingAssets after each
        // call, so assets validated by earlier endpoints are already present
        // and this branch is only reached for genuinely new network+token
        // combinations that need wallet address validation.
        const recipient = resolveWalletAddress(walletConfig, tp.network);
        if (!recipient) {
          result.warnings.push(
            `Endpoint ${endpoint.id}: token price references network "${tp.network}" but no wallet address is configured — rule for asset "${alias}" skipped`,
          );
          continue;
        }
        result.additionalAssets[alias] = buildAsset(tp, recipient);
      }
      result.rules.push({ match: "true", capture: tp.amount });
    }
  } else if (tenantPrices.length > 0) {
    // Fall back to tenant-level token prices combined with endpoint.price
    if (endpoint.price === null) {
      result.warnings.push(
        `Endpoint ${endpoint.id}: no price multiplier configured — defaulting to 1x against tenant-level prices`,
      );
    }
    const endpointMultiplier = endpoint.price ?? 1;

    for (const tp of tenantPrices) {
      const alias = `${tp.network}-${tp.token_symbol}`;
      if (!existingAssets[alias]) {
        // Already warned when building assets
        continue;
      }
      // Scale the tenant-level token price amount by the endpoint multiplier
      const scaledAmount = Math.round(Number(tp.amount) * endpointMultiplier);
      if (scaledAmount === 0 && endpointMultiplier !== 0) {
        result.warnings.push(
          `Endpoint ${endpoint.id}: scaled amount for asset "${alias}" rounds to 0 (amount=${tp.amount}, multiplier=${endpointMultiplier})`,
        );
      }
      result.rules.push({ match: "true", capture: String(scaledAmount) });
    }
  }

  return result;
}
