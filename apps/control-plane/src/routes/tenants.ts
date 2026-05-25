import { Hono } from "hono";
import { db } from "../db/instance.js";
import { syncToNode } from "../lib/sync.js";
import { logger } from "../logger.js";
import {
  upsertNodeDnsRecord,
  deleteNodeDnsRecord,
  deleteAllTenantDnsRecords,
  createHealthCheck,
  deleteHealthCheck,
} from "../lib/dns.js";
import { toDomainInfo } from "../lib/domain.js";
import { enqueueCertProvisioning } from "../lib/queue.js";
import { validateProxyName } from "../lib/proxy-name.js";
import { requireAdmin, requireTenantAccess } from "../middleware/auth.js";
import { arktypeValidator } from "@hono/arktype-validator";
import type { PricingRule } from "@faremeter/middleware-openapi";
import {
  CreateTenantSchema,
  DEFAULT_TENANT_SCHEME,
  PricingRulesPayloadSchema,
  UpdateTenantSchema,
  AssignNodeSchema,
} from "../lib/schemas.js";
import {
  seedTokenPricesForTenant,
  getUsdPeggedSymbols,
} from "../lib/token-seed.js";
import {
  createOpenApiSpec,
  getOpenApiSpec,
  getPricingRulesFromObject,
  setPricingRules,
  validateSpecPricingRules,
} from "../lib/pricing-rules.js";

export const tenantsRoutes = new Hono();

tenantsRoutes.use("/", requireAdmin);
tenantsRoutes.use("/:id", requireTenantAccess);
tenantsRoutes.use("/:id/*", requireTenantAccess);

tenantsRoutes.get("/", async (c) => {
  const tenants = await db
    .selectFrom("tenants")
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
  return c.json(tenants);
});

tenantsRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const tenant = await db
    .selectFrom("tenants")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }
  return c.json(tenant);
});

tenantsRoutes.post(
  "/",
  arktypeValidator("json", CreateTenantSchema),
  async (c) => {
    const body = c.req.valid("json");

    const nameValidation = validateProxyName(body.name);
    if (!nameValidation.valid) {
      return c.json({ error: nameValidation.error }, 400);
    }
    const sanitizedName = nameValidation.sanitized;

    let orgSlug: string | null = null;

    if (body.organization_id) {
      const org = await db
        .selectFrom("organizations")
        .select(["id", "slug"])
        .where("id", "=", body.organization_id)
        .executeTakeFirst();

      if (!org) {
        return c.json({ error: "Organization not found" }, 404);
      }
      orgSlug = org.slug;
    }

    const isRegisterOnly = body.register_only === true;

    const result = await db.transaction().execute(async (trx) => {
      const tenant = await trx
        .insertInto("tenants")
        .values({
          name: sanitizedName,
          backend_url: body.backend_url,
          organization_id: body.organization_id ?? null,
          wallet_id: body.wallet_id ?? null,
          default_price: body.default_price ?? 0,
          default_scheme: body.default_scheme ?? DEFAULT_TENANT_SCHEME,
          upstream_auth_header: body.upstream_auth_header ?? null,
          upstream_auth_value: body.upstream_auth_value ?? null,
          is_active: isRegisterOnly ? false : (body.is_active ?? true),
          org_slug: orgSlug,
          status: isRegisterOnly ? "registered" : "active",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await seedTokenPricesForTenant(trx, tenant.id, tenant.default_price);
      return tenant;
    });

    return c.json(result, 201);
  },
);

tenantsRoutes.put(
  "/:id",
  arktypeValidator("json", UpdateTenantSchema),
  async (c) => {
    const memberRole = c.get("memberRole");
    if (memberRole !== null) {
      return c.json(
        { error: "Use organization routes to manage tenants" },
        403,
      );
    }

    const id = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const tenant = await db
      .selectFrom("tenants")
      .select(["id", "status"])
      .where("id", "=", id)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    if (tenant.status !== "active" && tenant.status !== "registered") {
      return c.json(
        {
          error: "Cannot modify tenant while another operation is in progress",
        },
        400,
      );
    }

    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.backend_url !== undefined)
      updateData.backend_url = body.backend_url;
    if (body.organization_id !== undefined) {
      updateData.organization_id = body.organization_id;
      if (body.organization_id === null) {
        updateData.org_slug = null;
      } else {
        const org = await db
          .selectFrom("organizations")
          .select(["id", "slug"])
          .where("id", "=", body.organization_id)
          .executeTakeFirst();

        if (!org) {
          return c.json({ error: "Organization not found" }, 404);
        }

        updateData.org_slug = org.slug;
      }
    }
    if (body.wallet_id !== undefined) updateData.wallet_id = body.wallet_id;
    if (body.default_price !== undefined)
      updateData.default_price = body.default_price;
    if (body.default_scheme !== undefined)
      updateData.default_scheme = body.default_scheme;
    if (body.upstream_auth_header !== undefined)
      updateData.upstream_auth_header = body.upstream_auth_header;
    if (body.upstream_auth_value !== undefined)
      updateData.upstream_auth_value = body.upstream_auth_value;
    if (body.is_active !== undefined) updateData.is_active = body.is_active;

    const result = await db
      .updateTable("tenants")
      .set(updateData)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    // Propagate default_price to USD-pegged tenant-level token_prices only
    if (body.default_price !== undefined) {
      const usdSymbols = await getUsdPeggedSymbols(db);
      if (usdSymbols.length > 0) {
        await db
          .updateTable("token_prices")
          .set({ amount: body.default_price, updated_at: new Date() })
          .where("tenant_id", "=", id)
          .where("endpoint_id", "is", null)
          .where("token_symbol", "in", usdSymbols)
          .execute();
      }
    }

    const assignedNodes = await db
      .selectFrom("tenant_nodes")
      .select(["node_id"])
      .where("tenant_id", "=", id)
      .execute();

    for (const { node_id } of assignedNodes) {
      syncToNode(node_id).catch((err: unknown) => logger.error(String(err)));
    }

    return c.json(result);
  },
);

tenantsRoutes.get("/:id/pricing-rules", async (c) => {
  const id = parseInt(c.req.param("id"));

  const tenant = await db
    .selectFrom("tenants")
    .select(["id", "openapi_spec"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const spec = getOpenApiSpec(tenant.openapi_spec);
  return c.json({
    rules: spec ? (getPricingRulesFromObject(spec) ?? []) : [],
    editable: true,
  });
});

tenantsRoutes.put(
  "/:id/pricing-rules",
  arktypeValidator("json", PricingRulesPayloadSchema),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const tenant = await db
      .selectFrom("tenants")
      .select(["id", "name", "openapi_spec"])
      .where("id", "=", id)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const spec =
      getOpenApiSpec(tenant.openapi_spec) ?? createOpenApiSpec(tenant.name);
    setPricingRules(spec, body.rules as PricingRule[]);

    const validationError = validateSpecPricingRules(spec);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    await db
      .updateTable("tenants")
      .set({ openapi_spec: JSON.stringify(spec) })
      .where("id", "=", id)
      .execute();

    const assignedNodes = await db
      .selectFrom("tenant_nodes")
      .select(["node_id"])
      .where("tenant_id", "=", id)
      .execute();

    for (const { node_id } of assignedNodes) {
      syncToNode(node_id).catch((err: unknown) => logger.error(String(err)));
    }

    return c.json({ rules: body.rules });
  },
);

tenantsRoutes.delete("/:id", async (c) => {
  const memberRole = c.get("memberRole");
  if (memberRole !== null) {
    return c.json({ error: "Use organization routes to manage tenants" }, 403);
  }

  const id = parseInt(c.req.param("id"));

  const tenant = await db
    .selectFrom("tenants")
    .select(["id", "name", "org_slug"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const domainInfo = toDomainInfo(tenant);

  const tenantNodes = await db
    .selectFrom("tenant_nodes")
    .select(["node_id", "health_check_id"])
    .where("tenant_id", "=", id)
    .execute();

  await db.deleteFrom("transactions").where("tenant_id", "=", id).execute();
  await db.deleteFrom("endpoints").where("tenant_id", "=", id).execute();

  const result = await db
    .deleteFrom("tenants")
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  deleteAllTenantDnsRecords(domainInfo).catch((err: unknown) =>
    logger.error(`Failed to delete DNS for tenant ${tenant.name}: ${err}`),
  );

  for (const { node_id, health_check_id } of tenantNodes) {
    if (health_check_id) {
      deleteHealthCheck(health_check_id).catch((err: unknown) =>
        logger.error(`Failed to delete health check: ${err}`),
      );
    }
    syncToNode(node_id).catch((err: unknown) => logger.error(String(err)));
  }

  return c.json({ deleted: true });
});

tenantsRoutes.get("/:id/nodes", async (c) => {
  const tenantId = parseInt(c.req.param("id"));

  const tenant = await db
    .selectFrom("tenants")
    .select(["id", "name"])
    .where("id", "=", tenantId)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const tenantNodes = await db
    .selectFrom("tenant_nodes")
    .innerJoin("nodes", "nodes.id", "tenant_nodes.node_id")
    .select([
      "tenant_nodes.id",
      "tenant_nodes.node_id",
      "tenant_nodes.is_primary",
      "tenant_nodes.created_at",
      "nodes.name as node_name",
      "nodes.internal_ip",
      "nodes.public_ip",
      "nodes.status",
    ])
    .where("tenant_nodes.tenant_id", "=", tenantId)
    .execute();

  return c.json(tenantNodes);
});

tenantsRoutes.post(
  "/:id/nodes",
  arktypeValidator("json", AssignNodeSchema),
  async (c) => {
    // TODO: tighten to specific roles once role-based permissions are defined
    const memberRole = c.get("memberRole");
    if (memberRole && !["owner", "admin", "member"].includes(memberRole)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const tenantId = parseInt(c.req.param("id"));
    const body = c.req.valid("json");
    const nodeId = body.node_id;
    const isPrimary = body.is_primary ?? false;

    const tenant = await db
      .selectFrom("tenants")
      .select(["id", "name", "org_slug"])
      .where("id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const domainInfo = toDomainInfo(tenant);

    const node = await db
      .selectFrom("nodes")
      .select(["id", "public_ip", "status"])
      .where("id", "=", nodeId)
      .executeTakeFirst();

    if (!node) {
      return c.json({ error: "Node not found" }, 404);
    }

    if (!node.public_ip) {
      return c.json(
        { error: "Node does not have a public IP configured" },
        400,
      );
    }

    const existing = await db
      .selectFrom("tenant_nodes")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("node_id", "=", nodeId)
      .executeTakeFirst();

    if (existing) {
      return c.json({ error: "Node already assigned to tenant" }, 409);
    }

    if (isPrimary) {
      await db
        .updateTable("tenant_nodes")
        .set({ is_primary: false })
        .where("tenant_id", "=", tenantId)
        .execute();
    }

    const result = await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenantId,
        node_id: nodeId,
        is_primary: isPrimary,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const healthCheckId = await createHealthCheck(domainInfo, node.public_ip);
    if (healthCheckId) {
      await db
        .updateTable("tenant_nodes")
        .set({ health_check_id: healthCheckId })
        .where("id", "=", result.id)
        .execute();
    }

    upsertNodeDnsRecord(
      domainInfo,
      nodeId,
      node.public_ip,
      healthCheckId,
    ).catch((err: unknown) =>
      logger.error(`Failed to create DNS record: ${err}`),
    );

    if (node.status === "active") {
      enqueueCertProvisioning([nodeId], tenant.name, domainInfo.orgSlug).catch(
        (err: unknown) =>
          logger.error(
            `Failed to enqueue cert provisioning for tenant ${tenant.name} on node ${nodeId}: ${err}`,
          ),
      );
    }

    syncToNode(nodeId).catch((err: unknown) => logger.error(String(err)));

    return c.json(result, 201);
  },
);

tenantsRoutes.delete("/:id/nodes/:nodeId", async (c) => {
  const memberRole = c.get("memberRole");
  if (memberRole && !["owner", "admin", "member"].includes(memberRole)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const tenantId = parseInt(c.req.param("id"));
  const nodeId = parseInt(c.req.param("nodeId"));

  const tenant = await db
    .selectFrom("tenants")
    .select(["id", "name", "org_slug"])
    .where("id", "=", tenantId)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const domainInfo = toDomainInfo(tenant);

  const result = await db
    .deleteFrom("tenant_nodes")
    .where("tenant_id", "=", tenantId)
    .where("node_id", "=", nodeId)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    return c.json({ error: "Node assignment not found" }, 404);
  }

  if (result.health_check_id) {
    deleteHealthCheck(result.health_check_id).catch((err: unknown) =>
      logger.error(`Failed to delete health check: ${err}`),
    );
  }

  deleteNodeDnsRecord(domainInfo, nodeId).catch((err: unknown) =>
    logger.error(`Failed to delete DNS record: ${err}`),
  );

  syncToNode(nodeId).catch((err: unknown) => logger.error(String(err)));

  return c.json({ deleted: true });
});
