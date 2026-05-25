import {
  createPricingEvaluator,
  extractSpec,
} from "@faremeter/middleware-openapi";
import type { PricingRule } from "@faremeter/middleware-openapi";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";

export const OPENAPI_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;

export type OpenApiMethod = (typeof OPENAPI_METHODS)[number];
export type OpenApiOperation = Record<string, unknown>;
export type OpenApiPathItem = Record<string, unknown>;
export type OpenApiSpec = Record<string, unknown> & {
  info?: Record<string, unknown>;
  paths?: Record<string, unknown>;
};
type DbExecutor = Kysely<Database> | Transaction<Database>;
export type PricingRulesUpdateResult =
  | { ok: true; rules: PricingRule[]; updatedOperations: number }
  | { ok: false; error: string; status: 400 | 404 };

export type EndpointPricingTarget = {
  openapi_source_paths: string[] | null;
  http_method: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getOpenApiSpec(value: unknown): OpenApiSpec | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createOpenApiSpec(title: string): OpenApiSpec {
  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths: {},
  };
}

export function createOpenApiSpecWithRootPricingRules(
  title: string,
  rules: PricingRule[],
): OpenApiSpec {
  const spec = createOpenApiSpec(title);
  setPricingRules(spec, rules);
  return spec;
}

export function getOpenApiPaths(spec: OpenApiSpec): Record<string, unknown> {
  if (isRecord(spec.paths)) {
    return spec.paths;
  }
  spec.paths = {};
  return spec.paths;
}

export function getOpenApiPathItem(
  spec: OpenApiSpec,
  path: string,
): OpenApiPathItem | null {
  const paths = getOpenApiPaths(spec);
  const item = paths[path];
  if (!isRecord(item)) {
    return null;
  }
  return item;
}

export function getOpenApiOperation(
  pathItem: OpenApiPathItem,
  method: OpenApiMethod,
): OpenApiOperation | null {
  const operation = pathItem[method];
  if (!isRecord(operation)) {
    return null;
  }
  return operation;
}

export function getPricingRulesFromObject(
  value: unknown,
): PricingRule[] | null {
  if (!isRecord(value)) {
    return null;
  }
  const pricing = value["x-faremeter-pricing"];
  if (!isRecord(pricing) || !Array.isArray(pricing.rules)) {
    return null;
  }
  return structuredClone(pricing.rules) as PricingRule[];
}

export function getEffectiveOperationPricingRules(
  spec: OpenApiSpec,
  path: string,
  method: OpenApiMethod,
): PricingRule[] | null {
  const operation =
    extractSpec(spec).operations[`${method.toUpperCase()} ${path}`];
  return operation?.rules ? structuredClone(operation.rules) : null;
}

export function setPricingRules(
  target: Record<string, unknown>,
  rules: PricingRule[],
): void {
  const pricing = isRecord(target["x-faremeter-pricing"])
    ? { ...target["x-faremeter-pricing"] }
    : {};
  pricing.rules = structuredClone(rules);
  target["x-faremeter-pricing"] = pricing;
}

export function methodCandidates(httpMethod: string | null): OpenApiMethod[] {
  if (!httpMethod || httpMethod === "ANY") {
    return [...OPENAPI_METHODS];
  }
  const method = httpMethod.toLowerCase();
  return OPENAPI_METHODS.includes(method as OpenApiMethod)
    ? [method as OpenApiMethod]
    : [];
}

export function validateSpecPricingRules(spec: OpenApiSpec): string | null {
  try {
    createPricingEvaluator(extractSpec(spec));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function validateOperationPricingRules(
  baseSpec: OpenApiSpec,
  sourcePaths: string[],
  methods: OpenApiMethod[],
  rules: PricingRule[],
): string | null {
  const spec = structuredClone(baseSpec);
  for (const sourcePath of sourcePaths) {
    const pathItem = getOpenApiPathItem(spec, sourcePath);
    if (!pathItem) {
      return `OpenAPI path not found: ${sourcePath}`;
    }
    for (const method of methods) {
      const operation = getOpenApiOperation(pathItem, method);
      if (operation) {
        setPricingRules(operation, rules);
      }
    }
  }

  return validateSpecPricingRules(spec);
}

export async function applyEndpointPricingRules(
  executor: DbExecutor,
  tenantId: number,
  endpoint: EndpointPricingTarget,
  rules: PricingRule[],
): Promise<PricingRulesUpdateResult> {
  const sourcePaths = endpoint.openapi_source_paths ?? [];
  if (sourcePaths.length === 0) {
    return {
      ok: false,
      error: "Pricing rules require an OpenAPI-backed endpoint",
      status: 400,
    };
  }

  const tenant = await executor
    .selectFrom("tenants")
    .select("openapi_spec")
    .where("id", "=", tenantId)
    .executeTakeFirst();

  const spec = getOpenApiSpec(tenant?.openapi_spec);
  if (!tenant || !spec) {
    return {
      ok: false,
      error: "Tenant does not have an OpenAPI spec",
      status: 400,
    };
  }

  const methods = methodCandidates(endpoint.http_method);
  if (methods.length === 0) {
    return {
      ok: false,
      error: `Unsupported OpenAPI method: ${endpoint.http_method}`,
      status: 400,
    };
  }

  let updatedOperations = 0;
  for (const sourcePath of sourcePaths) {
    const pathItem = getOpenApiPathItem(spec, sourcePath);
    if (!pathItem) {
      return {
        ok: false,
        error: `OpenAPI path not found: ${sourcePath}`,
        status: 400,
      };
    }

    for (const method of methods) {
      const operation = getOpenApiOperation(pathItem, method);
      if (!operation) continue;
      setPricingRules(operation, rules);
      updatedOperations++;
    }
  }

  if (updatedOperations === 0) {
    return {
      ok: false,
      error: "No OpenAPI operation found for this endpoint",
      status: 400,
    };
  }

  const validationError = validateOperationPricingRules(
    spec,
    sourcePaths,
    methods,
    rules,
  );
  if (validationError) {
    return { ok: false, error: validationError, status: 400 };
  }

  await executor
    .updateTable("tenants")
    .set({ openapi_spec: JSON.stringify(spec) })
    .where("id", "=", tenantId)
    .execute();

  return { ok: true, rules, updatedOperations };
}
