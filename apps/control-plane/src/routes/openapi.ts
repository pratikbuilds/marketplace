import { Hono } from "hono";
import { db } from "../db/instance.js";
import { endpointPathToOpenApiPath } from "../lib/openapi-sync.js";
import { syncToNode } from "../lib/sync.js";
import { logger } from "../logger.js";
import { requireTenantAccess } from "../middleware/auth.js";
import {
  createResourceLimiter,
  modifyResourceLimiter,
} from "../middleware/rate-limit.js";
import { type } from "arktype";
import { arktypeValidator } from "@hono/arktype-validator";
import {
  OpenApiImportSchema,
  ValidatePatternSchema,
  OpenApiExtensionsSchema,
} from "../lib/schemas.js";
import {
  getOpenApiSpec,
  getPricingRulesFromObject,
  isRecord,
  methodCandidates,
} from "../lib/pricing-rules.js";

export const openapiRoutes = new Hono();

openapiRoutes.use("*", requireTenantAccess);

interface OpenApiSpec {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  paths?: Record<string, PathItem>;
  [key: string]: unknown;
}

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
  summary?: string;
  description?: string;
  [key: string]: unknown;
}

interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  [key: string]: unknown;
}

function validateOpenApiSpec(spec: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    errors.push("Only OpenAPI 3.x specs are supported");
  }

  if (!isRecord(spec.paths)) {
    errors.push("Missing or invalid 'paths' object");
  } else {
    for (const path of Object.keys(spec.paths)) {
      if (!path.startsWith("/")) {
        errors.push(`Path '${path}' must start with '/'`);
      }
    }
  }

  return errors;
}

function openApiPathToRegex(path: string): string {
  // Escape special regex chars except {}
  const escaped = path.replace(/[.*+?^$|()[\]\\]/g, "\\$&");
  // Replace {param} with [^/]+
  const regex = escaped.replace(/\{[^}]+\}/g, "[^/]+");
  return `^${regex}$`;
}

interface ExtractedPath {
  path: string;
  pattern: string;
  description: string | null;
  price: number | null;
  scheme: string | null;
  tags: string[] | null;
}

function extractPathsFromSpec(spec: OpenApiSpec): ExtractedPath[] {
  const paths: ExtractedPath[] = [];

  if (!spec.paths) return paths;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (path === "/" || path === "/*") continue;

    const item = pathItem;
    let description: string | null = item.summary ?? item.description ?? null;
    if (!description) {
      const methods = [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ] as const;
      for (const method of methods) {
        const op = item[method];
        const operationText =
          op?.summary !== undefined && op.summary !== ""
            ? op.summary
            : (op?.description ?? null);
        if (operationText) {
          description = operationText;
          break;
        }
      }
    }

    const raw = item as Record<string, unknown>;
    const pricing = raw["x-faremeter-pricing"] as
      | Record<string, unknown>
      | undefined;
    const rawTags = raw["x-faremeter-tags"];

    const extInput: Record<string, unknown> = {};
    if (pricing?.price !== undefined) extInput.price = pricing.price;
    if (pricing?.scheme !== undefined) extInput.scheme = pricing.scheme;
    if (Array.isArray(rawTags) && rawTags.length > 0) extInput.tags = rawTags;

    const ext = OpenApiExtensionsSchema(extInput);

    const isOrphan = raw["x-faremeter-orphan"] === true;
    const originalPattern =
      typeof raw["x-faremeter-original-pattern"] === "string"
        ? raw["x-faremeter-original-pattern"]
        : null;
    const pattern =
      isOrphan && originalPattern ? originalPattern : openApiPathToRegex(path);

    if (ext instanceof type.errors) {
      paths.push({
        path,
        pattern,
        description,
        price: null,
        scheme: null,
        tags: null,
      });
    } else {
      const v = ext as {
        price?: number | null;
        scheme?: string | null;
        tags?: string[];
      };
      paths.push({
        path,
        pattern,
        description,
        price: v.price ?? null,
        scheme: v.scheme ?? null,
        tags: v.tags ?? null,
      });
    }
  }

  return paths;
}

function testPatternMatch(pattern: string, path: string): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(path);
  } catch {
    return false;
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function endpointMethods(httpMethod: string | null): readonly string[] {
  const methods = methodCandidates(httpMethod);
  if (methods.length > 0) {
    return methods;
  }

  const method = httpMethod?.toLowerCase();
  return method === "head" || method === "options" ? [method] : [];
}

function hasPricingRules(value: unknown): boolean {
  return getPricingRulesFromObject(value) !== null;
}

function hasEffectivePricingRules(
  spec: OpenApiSpec,
  path: string,
  httpMethod: string | null,
): boolean {
  if (hasPricingRules(spec)) {
    return true;
  }

  const pathItem = spec.paths?.[path];
  if (!isRecord(pathItem)) {
    return false;
  }
  if (hasPricingRules(pathItem)) {
    return true;
  }

  return endpointMethods(httpMethod).some((method) =>
    hasPricingRules(pathItem[method]),
  );
}

openapiRoutes.get("/spec", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");

  const tenant = await db
    .selectFrom("tenants")
    .select(["openapi_spec"])
    .where("id", "=", tenantId)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  return c.json({
    spec: tenant.openapi_spec ?? null,
    hasSpec: tenant.openapi_spec !== null,
  });
});

openapiRoutes.delete("/spec", modifyResourceLimiter, async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");

  const result = await db
    .updateTable("tenants")
    .set({ openapi_spec: null })
    .where("id", "=", tenantId)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  return c.json({ success: true });
});

openapiRoutes.post(
  "/import",
  createResourceLimiter,
  arktypeValidator("json", OpenApiImportSchema),
  async (c) => {
    const tenantId = parseInt(c.req.param("tenantId") ?? "");
    const body = c.req.valid("json");

    if (!isRecord(body.spec)) {
      return c.json(
        { error: "Invalid OpenAPI spec", details: ["Spec must be an object"] },
        400,
      );
    }
    const validationErrors = validateOpenApiSpec(body.spec);
    if (validationErrors.length > 0) {
      return c.json(
        {
          error: "Invalid OpenAPI spec",
          details: validationErrors,
        },
        400,
      );
    }

    const spec = body.spec as OpenApiSpec;
    const paths = extractPathsFromSpec(spec);

    if (paths.length === 0) {
      return c.json({ error: "No paths found in spec" }, 400);
    }

    const tenant = await db
      .selectFrom("tenants")
      .select(["openapi_spec"])
      .where("id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const existingRootPricing = getRootPricingExtension(tenant.openapi_spec);
    if (
      existingRootPricing !== null &&
      getRootPricingExtension(spec) === null
    ) {
      spec["x-faremeter-pricing"] = existingRootPricing;
    }

    await db
      .updateTable("tenants")
      .set({ openapi_spec: JSON.stringify(spec) })
      .where("id", "=", tenantId)
      .execute();

    const existingEndpoints = await db
      .selectFrom("endpoints")
      .select(["id", "path_pattern"])
      .where("tenant_id", "=", tenantId)
      .where("is_active", "=", true)
      .execute();

    const existingPatternMap = new Map(
      existingEndpoints.map((e) => [e.path_pattern, e.id]),
    );

    const created: string[] = [];
    const linked: string[] = [];

    for (const pathInfo of paths) {
      const existingId = existingPatternMap.get(pathInfo.pattern);

      if (existingId) {
        const updates: Record<string, unknown> = {
          openapi_source_paths: [pathInfo.path],
        };
        if (pathInfo.description !== null)
          updates.description = pathInfo.description;
        if (pathInfo.price !== null) updates.price = pathInfo.price;
        if (pathInfo.scheme !== null) updates.scheme = pathInfo.scheme;
        if (pathInfo.tags !== null) updates.tags = pathInfo.tags;

        await db
          .updateTable("endpoints")
          .set(updates)
          .where("id", "=", existingId)
          .execute();
        linked.push(pathInfo.path);
      } else {
        await db
          .insertInto("endpoints")
          .values({
            tenant_id: tenantId,
            path: pathInfo.path,
            path_pattern: pathInfo.pattern,
            description: pathInfo.description,
            priority: 100,
            is_active: true,
            openapi_source_paths: [pathInfo.path],
            ...(pathInfo.price !== null && {
              price: pathInfo.price,
            }),
            ...(pathInfo.scheme !== null && { scheme: pathInfo.scheme }),
            ...(pathInfo.tags !== null && { tags: pathInfo.tags }),
          })
          .execute();
        created.push(pathInfo.path);
      }
    }

    const tenantNodes = await db
      .selectFrom("tenant_nodes")
      .select("node_id")
      .where("tenant_id", "=", tenantId)
      .execute();

    for (const tn of tenantNodes) {
      syncToNode(tn.node_id).catch((err: unknown) => logger.error(String(err)));
    }

    return c.json({
      success: true,
      created: created.length,
      linked: linked.length,
      paths: {
        created,
        linked,
      },
    });
  },
);

openapiRoutes.get("/export", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");
  const includeOrphans = c.req.query("include_orphans") === "true";

  const tenant = await db
    .selectFrom("tenants")
    .select([
      "name",
      "backend_url",
      "openapi_spec",
      "default_price",
      "default_scheme",
    ])
    .where("id", "=", tenantId)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const endpoints = await db
    .selectFrom("endpoints")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("is_active", "=", true)
    .orderBy("priority", "asc")
    .execute();

  let baseSpec: OpenApiSpec;
  const storedSpec = getOpenApiSpec(tenant.openapi_spec);
  if (storedSpec) {
    baseSpec = storedSpec as OpenApiSpec;
  } else {
    baseSpec = {
      openapi: "3.0.3",
      info: {
        title: tenant.name,
        version: "1.0.0",
      },
      paths: {},
    };
  }

  const exportedSpec: OpenApiSpec = structuredClone(baseSpec);
  exportedSpec.paths ??= {};

  const warnings: string[] = [];
  const orphanEndpoints: { pattern: string; description: string | null }[] = [];

  for (const endpoint of endpoints) {
    const sourcePaths = endpoint.openapi_source_paths;

    if (sourcePaths && sourcePaths.length > 0) {
      // Has lineage - preserve advanced pricing or add fixed fallback pricing.
      for (const sourcePath of sourcePaths) {
        exportedSpec.paths ??= {};
        exportedSpec.paths[sourcePath] ??= {};

        const pathObj = exportedSpec.paths[sourcePath] as Record<
          string,
          unknown
        >;

        if (endpoint.description) {
          pathObj.description = endpoint.description;
        }

        if (
          !hasEffectivePricingRules(baseSpec, sourcePath, endpoint.http_method)
        ) {
          pathObj["x-faremeter-pricing"] = {
            price: endpoint.price ?? tenant.default_price,
            scheme: endpoint.scheme ?? tenant.default_scheme,
          };
        }

        const tags = endpoint.tags as string[] | null;
        if (tags && tags.length > 0) {
          pathObj["x-faremeter-tags"] = tags;
        }
      }
    } else {
      // Orphan endpoint - no lineage
      orphanEndpoints.push({
        pattern: endpoint.path_pattern,
        description: endpoint.description,
      });

      if (includeOrphans) {
        const displayPath = endpointPathToOpenApiPath(
          endpoint.path,
          endpoint.path_pattern,
        );
        if (!displayPath) continue;

        exportedSpec.paths ??= {};
        const orphanPath: Record<string, unknown> = {
          "x-faremeter-orphan": true,
          "x-faremeter-original-pattern": endpoint.path_pattern,
          "x-faremeter-pricing": {
            price: endpoint.price ?? tenant.default_price,
            scheme: endpoint.scheme ?? tenant.default_scheme,
          },
        };

        if (endpoint.description) {
          orphanPath.description = endpoint.description;
        }

        const orphanTags = endpoint.tags as string[] | null;
        if (orphanTags && orphanTags.length > 0) {
          orphanPath["x-faremeter-tags"] = orphanTags;
        }

        exportedSpec.paths[displayPath] = orphanPath;
      } else {
        warnings.push(
          `Endpoint '${endpoint.path_pattern}' has no OpenAPI lineage and will not be exported`,
        );
      }
    }
  }

  return c.json({
    spec: exportedSpec,
    warnings,
    orphanEndpoints,
    stats: {
      totalEndpoints: endpoints.length,
      withLineage: endpoints.length - orphanEndpoints.length,
      orphans: orphanEndpoints.length,
    },
  });
});

openapiRoutes.post(
  "/validate-pattern",
  arktypeValidator("json", ValidatePatternSchema),
  async (c) => {
    const tenantId = parseInt(c.req.param("tenantId") ?? "");
    const body = c.req.valid("json");
    const pattern = body.pattern;

    if (!isValidRegex(pattern)) {
      return c.json({
        valid: false,
        isValidRegex: false,
        matches: [],
        error: "Invalid regex pattern",
      });
    }

    const tenant = await db
      .selectFrom("tenants")
      .select(["openapi_spec"])
      .where("id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    if (!tenant.openapi_spec) {
      return c.json({
        valid: true,
        isValidRegex: true,
        matches: [],
        hasSpec: false,
      });
    }

    const spec = tenant.openapi_spec as OpenApiSpec;
    const specPaths = Object.keys(spec.paths ?? {});

    const matches: string[] = [];
    for (const path of specPaths) {
      if (testPatternMatch(pattern, path)) {
        matches.push(path);
      }
    }

    return c.json({
      valid: true,
      isValidRegex: true,
      matches,
      hasSpec: true,
      totalSpecPaths: specPaths.length,
    });
  },
);

function getRootPricingExtension(
  spec: unknown,
): Record<string, unknown> | null {
  const parsedSpec = getOpenApiSpec(spec);
  if (!parsedSpec || !isRecord(parsedSpec["x-faremeter-pricing"])) {
    return null;
  }
  return structuredClone(parsedSpec["x-faremeter-pricing"]);
}
