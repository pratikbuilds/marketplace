import { Hono } from "hono";
import { randomBytes } from "crypto";
import { db } from "../db/instance.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createResourceLimiter,
  modifyResourceLimiter,
} from "../middleware/rate-limit.js";
import {
  fetchWalletBalances,
  extractAddresses,
  checkBalancesMeetMinimum,
  BALANCE_CACHE_TTL_MS,
  type WalletBalances,
  type WalletConfig,
} from "../lib/balances.js";
import { logger } from "../logger.js";
import { syncToNode } from "../lib/sync.js";
import { createHealthCheck, upsertNodeDnsRecord } from "../lib/dns.js";
import {
  enqueueCertProvisioning,
  enqueueTenantDeletion,
  checkAndUpdateTenantStatus,
  enqueueEmail,
} from "../lib/queue.js";
import { getSiteUrl } from "../lib/email.js";
import {
  setupAccountWithAddresses,
  updateAccountAddresses,
} from "../lib/faremeter-dash.js";
import { validateProxyName } from "../lib/proxy-name.js";
import { slugify, generateSlugSuffix } from "../lib/slug.js";
import { toDomainInfo } from "../lib/domain.js";
import {
  getOrganizationEarnings,
  getTenantEarnings,
  getEndpointEarnings,
  getCatchAllEarnings,
  getEarningsByPeriod,
  type Granularity,
} from "../lib/analytics.js";
import { arktypeValidator } from "@hono/arktype-validator";
import {
  OrgCreateTenantSchema,
  DEFAULT_TENANT_SCHEME,
  OrgUpdateTenantSchema,
  AddMemberSchema,
  UpdateMemberSchema,
  CreateOrganizationSchema,
  UpdateOrganizationSchema,
} from "../lib/schemas.js";
import {
  seedTokenPricesForTenant,
  getUsdPeggedSymbols,
} from "../lib/token-seed.js";
import {
  applyTenantPricingRules,
  createOpenApiSpecWithRootPricingRules,
  validateSpecPricingRules,
} from "../lib/pricing-rules.js";

export const organizationsRoutes = new Hono();

organizationsRoutes.use("*", requireAuth);

organizationsRoutes.get("/", async (c) => {
  const user = c.get("user");

  const organizations = await db
    .selectFrom("user_organizations")
    .innerJoin(
      "organizations",
      "organizations.id",
      "user_organizations.organization_id",
    )
    .select([
      "organizations.id",
      "organizations.name",
      "organizations.slug",
      "organizations.created_at",
      "user_organizations.role",
    ])
    .where("user_organizations.user_id", "=", user.id)
    .orderBy("organizations.name", "asc")
    .execute();

  return c.json(organizations);
});

const MAX_ORGS_PER_USER = 5;

organizationsRoutes.get("/check-slug", async (c) => {
  const slug = c.req.query("slug");

  if (!slug) {
    return c.json({ error: "slug query parameter is required" }, 400);
  }

  const existing = await db
    .selectFrom("organizations")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();

  if (!existing) {
    return c.json({ available: true, slug });
  }

  const suggested = `${slug}-${generateSlugSuffix()}`;
  return c.json({ available: false, suggested });
});

organizationsRoutes.post(
  "/",
  createResourceLimiter,
  arktypeValidator("json", CreateOrganizationSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const orgCount = await db
      .selectFrom("user_organizations")
      .select((eb) => eb.fn.count<number>("id").as("count"))
      .where("user_id", "=", user.id)
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();

    if (orgCount.count >= MAX_ORGS_PER_USER) {
      return c.json(
        {
          error: `You can only create up to ${MAX_ORGS_PER_USER} organizations`,
        },
        400,
      );
    }

    let slug = body.slug ?? slugify(body.name);

    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      const existingSlug = await db
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", slug)
        .executeTakeFirst();

      if (!existingSlug) break;

      const baseSlug = body.slug ?? slugify(body.name);
      slug = `${baseSlug}-${generateSlugSuffix()}`;
    }

    const org = await db
      .insertInto("organizations")
      .values({
        name: body.name,
        slug,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("user_organizations")
      .values({
        user_id: user.id,
        organization_id: org.id,
        role: "owner",
      })
      .execute();

    return c.json({ ...org, role: "owner" }, 201);
  },
);

organizationsRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", id)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const org = await db
    .selectFrom("organizations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  return c.json({ ...org, role: membership?.role ?? "admin" });
});

organizationsRoutes.put(
  "/:id",
  modifyResourceLimiter,
  arktypeValidator("json", UpdateOrganizationSchema),
  async (c) => {
    const user = c.get("user");
    const id = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", id)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (membership && membership.role !== "owner" && !user.is_admin) {
      return c.json({ error: "Only owners can update the organization" }, 403);
    }

    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) {
      updateData.name = body.name.trim();
    }
    if (body.slug !== undefined) {
      const existingSlug = await db
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", body.slug)
        .where("id", "!=", id)
        .executeTakeFirst();

      if (existingSlug) {
        return c.json({ error: "Slug already in use" }, 409);
      }
      updateData.slug = body.slug;
    }

    const org = await db
      .updateTable("organizations")
      .set(updateData)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();

    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    return c.json(org);
  },
);

organizationsRoutes.delete("/:id", modifyResourceLimiter, async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", id)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  if (membership && membership.role !== "owner" && !user.is_admin) {
    return c.json({ error: "Only owners can delete the organization" }, 403);
  }

  // Check for org_slug tenants that would be orphaned
  const orgSlugTenants = await db
    .selectFrom("tenants")
    .select("id")
    .where("organization_id", "=", id)
    .where("org_slug", "is not", null)
    .execute();

  if (orgSlugTenants.length > 0) {
    return c.json(
      {
        error:
          "Cannot delete organization with active proxies. Delete proxies first.",
      },
      400,
    );
  }

  await db.deleteFrom("organizations").where("id", "=", id).execute();

  return c.json({ deleted: true });
});

organizationsRoutes.get("/:id/members", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", id)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const members = await db
    .selectFrom("user_organizations")
    .innerJoin("users", "users.id", "user_organizations.user_id")
    .select([
      "users.id",
      "users.email",
      "user_organizations.role",
      "user_organizations.joined_at",
    ])
    .where("user_organizations.organization_id", "=", id)
    .orderBy("user_organizations.joined_at", "asc")
    .execute();

  return c.json(members);
});

organizationsRoutes.post(
  "/:id/members",
  createResourceLimiter,
  arktypeValidator("json", AddMemberSchema),
  async (c) => {
    const user = c.get("user");
    const id = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", id)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (
      membership &&
      !["owner", "admin"].includes(membership.role) &&
      !user.is_admin
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const targetUser = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", body.email.toLowerCase().trim())
      .executeTakeFirst();

    if (!targetUser) {
      return c.json({ error: "User not found" }, 404);
    }

    const existingMembership = await db
      .selectFrom("user_organizations")
      .select("id")
      .where("user_id", "=", targetUser.id)
      .where("organization_id", "=", id)
      .executeTakeFirst();

    if (existingMembership) {
      return c.json({ error: "User is already a member" }, 409);
    }

    const role = body.role ?? "member";

    await db
      .insertInto("user_organizations")
      .values({
        user_id: targetUser.id,
        organization_id: id,
        role,
      })
      .execute();

    return c.json({ success: true }, 201);
  },
);

organizationsRoutes.delete(
  "/:id/members/:userId",
  modifyResourceLimiter,
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const targetUserId = parseInt(c.req.param("userId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (user.id === targetUserId) {
      await db
        .deleteFrom("user_organizations")
        .where("user_id", "=", targetUserId)
        .where("organization_id", "=", orgId)
        .execute();
      return c.json({ deleted: true });
    }

    if (
      membership &&
      !["owner", "admin"].includes(membership.role) &&
      !user.is_admin
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    await db
      .deleteFrom("user_organizations")
      .where("user_id", "=", targetUserId)
      .where("organization_id", "=", orgId)
      .execute();

    return c.json({ deleted: true });
  },
);

organizationsRoutes.patch(
  "/:id/members/:userId",
  modifyResourceLimiter,
  arktypeValidator("json", UpdateMemberSchema),
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const targetUserId = parseInt(c.req.param("userId"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (
      membership &&
      !["owner", "admin"].includes(membership.role) &&
      !user.is_admin
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const target = await db
      .selectFrom("user_organizations")
      .select(["id", "role"])
      .where("user_id", "=", targetUserId)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!target) {
      return c.json({ error: "Member not found" }, 404);
    }

    const isOwner = membership?.role === "owner";
    const isPlatformAdmin = user.is_admin;

    if (!isOwner && !isPlatformAdmin) {
      if (body.role === "owner") {
        return c.json({ error: "Only owners can assign the owner role" }, 403);
      }
      if (target.role === "owner") {
        return c.json({ error: "Only owners can change an owner's role" }, 403);
      }
    }

    await db
      .updateTable("user_organizations")
      .set({ role: body.role })
      .where("user_id", "=", targetUserId)
      .where("organization_id", "=", orgId)
      .execute();

    return c.json({ success: true });
  },
);

organizationsRoutes.get("/:id/tenants", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", id)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const tenants = await db
    .selectFrom("tenants")
    .leftJoin("wallets", "wallets.id", "tenants.wallet_id")
    .select([
      "tenants.id",
      "tenants.name",
      "tenants.backend_url",
      "tenants.is_active",
      "tenants.status",
      "tenants.wallet_id",
      "tenants.upstream_auth_header",
      "tenants.upstream_auth_value",
      "tenants.created_at",
      "tenants.default_price",
      "tenants.default_scheme",
      "tenants.org_slug",
      "wallets.name as wallet_name",
      "wallets.funding_status as wallet_funding_status",
    ])
    .where("tenants.organization_id", "=", id)
    .orderBy("tenants.created_at", "desc")
    .execute();

  const tenantIds = tenants.map((t) => t.id);

  const tenantNodes =
    tenantIds.length > 0
      ? await db
          .selectFrom("tenant_nodes")
          .select([
            "tenant_nodes.tenant_id",
            "tenant_nodes.node_id",
            "tenant_nodes.cert_status",
            "tenant_nodes.is_primary",
          ])
          .where("tenant_nodes.tenant_id", "in", tenantIds)
          .execute()
      : [];

  const nodesByTenant: Record<
    number,
    { id: number; cert_status: string | null; is_primary: boolean }[]
  > = {};
  for (const tn of tenantNodes) {
    const arr =
      nodesByTenant[tn.tenant_id] ?? (nodesByTenant[tn.tenant_id] = []);
    arr.push({
      id: tn.node_id,
      cert_status: tn.cert_status,
      is_primary: tn.is_primary,
    });
  }

  const result = tenants.map((t) => ({
    ...t,
    nodes: nodesByTenant[t.id] ?? [],
  }));

  return c.json(result);
});

organizationsRoutes.put(
  "/:id/tenants/:tenantId",
  modifyResourceLimiter,
  arktypeValidator("json", OrgUpdateTenantSchema),
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const tenantId = parseInt(c.req.param("tenantId"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const tenant = await db
      .selectFrom("tenants")
      .select(["id", "name", "organization_id", "status"])
      .where("id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant || tenant.organization_id !== orgId) {
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
    if (body.backend_url !== undefined) {
      updateData.backend_url = body.backend_url;
    }
    if (body.is_active !== undefined) updateData.is_active = body.is_active;
    if (body.upstream_auth_header !== undefined) {
      updateData.upstream_auth_header = body.upstream_auth_header || null; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- empty string means clear
    }
    if (body.upstream_auth_value !== undefined) {
      updateData.upstream_auth_value = body.upstream_auth_value || null; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- empty string means clear
    }
    if (body.default_price !== undefined) {
      updateData.default_price = body.default_price;
    }
    if (body.default_scheme !== undefined) {
      updateData.default_scheme = body.default_scheme;
    }

    let newWalletConfig: WalletConfig | null = null;
    if (body.wallet_id !== undefined) {
      if (body.wallet_id !== null) {
        const wallet = await db
          .selectFrom("wallets")
          .select(["id", "organization_id", "wallet_config"])
          .where("id", "=", body.wallet_id)
          .executeTakeFirst();

        if (!wallet || wallet.organization_id !== orgId) {
          return c.json({ error: "Wallet not found" }, 404);
        }
        newWalletConfig = wallet.wallet_config as WalletConfig | null;
      }
      updateData.wallet_id = body.wallet_id;
    }

    const transactionResult = await db.transaction().execute(async (trx) => {
      if (body.pricing_rules !== undefined) {
        const pricingResult = await applyTenantPricingRules(
          trx,
          tenantId,
          body.pricing_rules,
        );
        if (!pricingResult.ok) return pricingResult;
      }

      if (Object.keys(updateData).length === 0) {
        const current = await trx
          .selectFrom("tenants")
          .selectAll()
          .where("id", "=", tenantId)
          .executeTakeFirst();
        return { ok: true as const, tenant: current };
      }

      const result = await trx
        .updateTable("tenants")
        .set(updateData)
        .where("id", "=", tenantId)
        .returningAll()
        .executeTakeFirst();

      return { ok: true as const, tenant: result };
    });

    if (!transactionResult.ok) {
      return c.json(
        { error: transactionResult.error },
        transactionResult.status,
      );
    }

    const result = transactionResult.tenant;

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
          .where("tenant_id", "=", tenantId)
          .where("endpoint_id", "is", null)
          .where("token_symbol", "in", usdSymbols)
          .execute();
      }
    }

    // Skip syncing for registered tenants (not provisioned yet)
    if (tenant.status !== "registered") {
      const tenantNodes = await db
        .selectFrom("tenant_nodes")
        .select("node_id")
        .where("tenant_id", "=", tenantId)
        .execute();

      for (const tn of tenantNodes) {
        syncToNode(tn.node_id).catch((err: unknown) =>
          logger.error(String(err)),
        );
      }

      if (newWalletConfig) {
        const addresses = {
          solana: newWalletConfig.solana?.["mainnet-beta"]?.address,
          base: newWalletConfig.evm?.base?.address,
          polygon: newWalletConfig.evm?.polygon?.address,
          monad: newWalletConfig.evm?.monad?.address,
        };

        updateAccountAddresses(tenant.name, addresses).catch((err: unknown) =>
          logger.error(
            `Failed to update faremeter dash addresses for ${tenant.name}: ${err}`,
          ),
        );
      }

      if (body.wallet_id !== undefined && body.wallet_id !== null) {
        await checkAndUpdateTenantStatus(tenantId);
      }
    }

    return c.json(result);
  },
);

// Activate a registered tenant (go live)
organizationsRoutes.post(
  "/:id/tenants/:tenantId/activate",
  modifyResourceLimiter,
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const tenantId = parseInt(c.req.param("tenantId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Require owner/admin role to activate
    if (
      membership &&
      membership.role !== "owner" &&
      membership.role !== "admin" &&
      !user.is_admin
    ) {
      return c.json(
        { error: "Only owners or admins can activate proxies" },
        403,
      );
    }

    const tenant = await db
      .selectFrom("tenants")
      .leftJoin("wallets", "wallets.id", "tenants.wallet_id")
      .select([
        "tenants.id",
        "tenants.name",
        "tenants.status",
        "tenants.organization_id",
        "tenants.org_slug",
        "tenants.backend_url",
        "tenants.wallet_id",
        "wallets.wallet_config",
        "wallets.funding_status",
      ])
      .where("tenants.id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant || tenant.organization_id !== orgId) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    if (tenant.status !== "registered") {
      return c.json({ error: "Only registered tenants can be activated" }, 400);
    }

    if (!tenant.backend_url) {
      return c.json(
        { error: "A backend URL must be configured before going live" },
        400,
      );
    }

    if (!tenant.wallet_id) {
      return c.json(
        { error: "A wallet must be assigned before going live" },
        400,
      );
    }

    if (tenant.funding_status !== "funded") {
      return c.json(
        {
          error:
            "Wallet must be funded before going live. Add SOL and USDC to your wallet.",
        },
        400,
      );
    }

    await db
      .updateTable("tenants")
      .set({ status: "pending", is_active: true })
      .where("id", "=", tenantId)
      .execute();

    const tenantNodes = await db
      .selectFrom("tenant_nodes")
      .innerJoin("nodes", "nodes.id", "tenant_nodes.node_id")
      .select([
        "tenant_nodes.id as tn_id",
        "tenant_nodes.node_id",
        "nodes.public_ip",
        "nodes.status as node_status",
      ])
      .where("tenant_nodes.tenant_id", "=", tenantId)
      .execute();

    const domainInfo = toDomainInfo({
      name: tenant.name,
      org_slug: tenant.org_slug,
    });

    const activeNodeIds: number[] = [];

    for (const tn of tenantNodes) {
      await db
        .updateTable("tenant_nodes")
        .set({ cert_status: "pending" })
        .where("id", "=", tn.tn_id)
        .execute();

      if (tn.public_ip) {
        const healthCheckId = await createHealthCheck(domainInfo, tn.public_ip);
        if (healthCheckId) {
          await db
            .updateTable("tenant_nodes")
            .set({ health_check_id: healthCheckId })
            .where("id", "=", tn.tn_id)
            .execute();
        }

        upsertNodeDnsRecord(
          domainInfo,
          tn.node_id,
          tn.public_ip,
          healthCheckId,
        ).catch((err: unknown) =>
          logger.error(`Failed to create DNS record: ${err}`),
        );
      }

      if (tn.node_status === "active") {
        activeNodeIds.push(tn.node_id);
      }

      syncToNode(tn.node_id).catch((err: unknown) => logger.error(String(err)));
    }

    if (activeNodeIds.length > 0) {
      enqueueCertProvisioning(
        activeNodeIds,
        tenant.name,
        tenant.org_slug ?? null,
      ).catch((err: unknown) =>
        logger.error(`Failed to enqueue cert provisioning: ${err}`),
      );
    }

    const walletConfig = tenant.wallet_config as WalletConfig | null;
    if (walletConfig) {
      const accessToken = Math.random().toString(36).substring(2, 7);
      const addresses = {
        solana: walletConfig.solana?.["mainnet-beta"]?.address,
        base: walletConfig.evm?.base?.address,
        polygon: walletConfig.evm?.polygon?.address,
        monad: walletConfig.evm?.monad?.address,
      };

      setupAccountWithAddresses(tenant.name, accessToken, addresses).catch(
        (err: unknown) =>
          logger.error(
            `Failed to setup faremeter dash account for ${tenant.name}: ${err}`,
          ),
      );
    }

    await checkAndUpdateTenantStatus(tenantId);

    return c.json({ success: true, status: "pending" });
  },
);

organizationsRoutes.delete(
  "/:id/tenants/:tenantId",
  modifyResourceLimiter,
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const tenantId = parseInt(c.req.param("tenantId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Fetch tenant with org slug for domain info
    const tenant = await db
      .selectFrom("tenants")
      .leftJoin("wallets", "wallets.id", "tenants.wallet_id")
      .select([
        "tenants.id",
        "tenants.name",
        "tenants.status",
        "tenants.wallet_id",
        "tenants.organization_id",
        "tenants.org_slug",
        "wallets.wallet_config",
      ])
      .where("tenants.id", "=", tenantId)
      .executeTakeFirst();

    if (!tenant || tenant.organization_id !== orgId) {
      return c.json({ error: "Proxy not found" }, 404);
    }

    if (tenant.status === "deleting") {
      return c.json({ error: "Proxy is already being deleted" }, 400);
    }

    const tenantNodes = await db
      .selectFrom("tenant_nodes")
      .select(["cert_status"])
      .where("tenant_id", "=", tenantId)
      .execute();

    const hasCertInFlight = tenantNodes.some(
      (n) => n.cert_status === "pending" || n.cert_status === "deleting",
    );

    if (hasCertInFlight) {
      return c.json(
        { error: "Cannot delete while certificate operations are in progress" },
        400,
      );
    }

    if (tenant.status === "registered") {
      await db
        .deleteFrom("transactions")
        .where("tenant_id", "=", tenantId)
        .execute();
      await db
        .deleteFrom("endpoints")
        .where("tenant_id", "=", tenantId)
        .execute();
      await db
        .deleteFrom("tenant_nodes")
        .where("tenant_id", "=", tenantId)
        .execute();
      await db.deleteFrom("tenants").where("id", "=", tenantId).execute();
      return c.json({ success: true });
    }

    await db
      .updateTable("tenants")
      .set({ status: "deleting" })
      .where("id", "=", tenantId)
      .execute();

    await enqueueTenantDeletion(
      tenant.id,
      tenant.name,
      tenant.org_slug ?? null,
    );

    return c.json({ success: true });
  },
);

organizationsRoutes.get("/:id/tenants/check-name", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));
  const name = c.req.query("name");

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  if (!name?.trim()) {
    return c.json({ available: false });
  }

  const trimmedName = name.trim();

  const existingInOrg = await db
    .selectFrom("tenants")
    .select("id")
    .where("name", "=", trimmedName)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  return c.json({ available: !existingInOrg });
});

organizationsRoutes.get("/:id/can-create-proxy", async (c) => {
  const orgId = parseInt(c.req.param("id"));

  const adminSettings = await db
    .selectFrom("admin_settings")
    .select(["minimum_balance_sol", "minimum_balance_usdc"])
    .where("id", "=", 1)
    .executeTakeFirst();

  const minSol = adminSettings?.minimum_balance_sol ?? 0.001;
  const minUsdc = adminSettings?.minimum_balance_usdc ?? 0.01;

  const wallets = await db
    .selectFrom("wallets")
    .select([
      "id",
      "wallet_config",
      "funding_status",
      "cached_balances",
      "balances_cached_at",
    ])
    .where("organization_id", "=", orgId)
    .execute();

  if (wallets.length === 0) {
    return c.json({
      available: false,
      reason: "no_wallet",
      minimumSol: minSol,
      minimumUsdc: minUsdc,
    });
  }

  for (const wallet of wallets) {
    const cachedAt = wallet.balances_cached_at;
    const isCacheFresh =
      cachedAt &&
      wallet.cached_balances &&
      Date.now() - new Date(cachedAt).getTime() < BALANCE_CACHE_TTL_MS;

    if (isCacheFresh) {
      const cached =
        typeof wallet.cached_balances === "string"
          ? (JSON.parse(wallet.cached_balances) as WalletBalances)
          : (wallet.cached_balances as WalletBalances);
      if (checkBalancesMeetMinimum(cached, minSol, minUsdc)) {
        return c.json({ available: true });
      }
    } else {
      const config = wallet.wallet_config as WalletConfig | null;
      const addresses = extractAddresses(config);

      if (!addresses.solana && !addresses.evm) continue;

      try {
        const balances = await fetchWalletBalances(addresses);
        const isFunded = checkBalancesMeetMinimum(balances, minSol, minUsdc);

        await db
          .updateTable("wallets")
          .set({
            cached_balances: JSON.stringify(balances),
            balances_cached_at: new Date(),
            funding_status: isFunded ? "funded" : "pending",
          })
          .where("id", "=", wallet.id)
          .execute();

        if (isFunded) {
          return c.json({ available: true });
        }
      } catch (err) {
        logger.error(
          `Failed to fetch balances for wallet ${wallet.id}: ${err}`,
        );
        // If fetch fails but we have stale cache, use it as fallback
        if (wallet.cached_balances) {
          const cached =
            typeof wallet.cached_balances === "string"
              ? (JSON.parse(wallet.cached_balances) as WalletBalances)
              : (wallet.cached_balances as WalletBalances);
          if (checkBalancesMeetMinimum(cached, minSol, minUsdc)) {
            return c.json({ available: true });
          }
        }
      }
    }
  }

  return c.json({
    available: false,
    reason: "insufficient_funds",
    minimumSol: minSol,
    minimumUsdc: minUsdc,
  });
});

organizationsRoutes.post(
  "/:id/tenants",
  createResourceLimiter,
  arktypeValidator("json", OrgCreateTenantSchema),
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Fetch organization slug for the new URL format
    const org = await db
      .selectFrom("organizations")
      .select(["id", "slug"])
      .where("id", "=", orgId)
      .executeTakeFirst();

    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const nameValidation = validateProxyName(body.name);
    if (!nameValidation.valid) {
      return c.json({ error: nameValidation.error }, 400);
    }
    const sanitizedName = nameValidation.sanitized;

    // Check per-organization uniqueness
    const existingTenant = await db
      .selectFrom("tenants")
      .select("id")
      .where("name", "=", sanitizedName)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (existingTenant) {
      return c.json(
        { error: "A proxy with this name already exists in this organization" },
        409,
      );
    }

    const isRegisterOnly = body.register_only === true;

    // Wallet is required unless register_only
    if (!isRegisterOnly && !body.wallet_id) {
      return c.json({ error: "Wallet is required" }, 400);
    }

    let wallet = null;
    if (body.wallet_id) {
      wallet = await db
        .selectFrom("wallets")
        .selectAll()
        .where("id", "=", body.wallet_id)
        .where("organization_id", "=", orgId)
        .executeTakeFirst();

      if (!wallet) {
        return c.json(
          { error: "Wallet not found or does not belong to this organization" },
          400,
        );
      }
    }

    const nodesWithCounts = await db
      .selectFrom("nodes")
      .leftJoin("tenant_nodes", "tenant_nodes.node_id", "nodes.id")
      .select(["nodes.id", "nodes.public_ip", "nodes.status"])
      .select((eb) => [
        eb.fn.count<number>("tenant_nodes.id").as("tenant_count"),
      ])
      .where("nodes.status", "=", "active")
      .where("nodes.public_ip", "is not", null)
      .groupBy("nodes.id")
      .orderBy("tenant_count", "asc")
      .limit(2)
      .execute();

    if (nodesWithCounts.length < 2) {
      return c.json({ error: "Not enough active nodes available" }, 400);
    }

    const nodeIds = nodesWithCounts.map((n) => n.id);

    const rootPricingSpec =
      body.pricing_rules !== undefined
        ? createOpenApiSpecWithRootPricingRules(
            sanitizedName,
            body.pricing_rules,
          )
        : null;
    if (rootPricingSpec) {
      const validationError = validateSpecPricingRules(rootPricingSpec);
      if (validationError) {
        return c.json({ error: validationError }, 400);
      }
    }

    const tenant = await db.transaction().execute(async (trx) => {
      const t = await trx
        .insertInto("tenants")
        .values({
          name: sanitizedName,
          backend_url: body.backend_url,
          organization_id: orgId,
          wallet_id: body.wallet_id ?? null,
          default_price: body.default_price ?? 0,
          default_scheme: body.default_scheme ?? DEFAULT_TENANT_SCHEME,
          upstream_auth_header: body.upstream_auth_header ?? null,
          upstream_auth_value: body.upstream_auth_value ?? null,
          ...(rootPricingSpec !== null && {
            openapi_spec: JSON.stringify(rootPricingSpec),
          }),
          org_slug: org.slug,
          is_active: !isRegisterOnly,
          status: isRegisterOnly ? "registered" : "pending",
        })
        .returningAll()
        .executeTakeFirst();

      if (!t) throw new Error("Failed to create proxy");

      await seedTokenPricesForTenant(trx, t.id, t.default_price);
      return t;
    });

    if (!tenant) {
      return c.json({ error: "Failed to create proxy" }, 500);
    }

    // Build domain info for DNS/cert operations
    const domainInfo = toDomainInfo({
      name: sanitizedName,
      org_slug: org.slug,
    });

    const activeNodeIds: number[] = [];

    for (const [i, nodeId] of nodeIds.entries()) {
      const isPrimary = i === 0;
      const node = nodesWithCounts.find((n) => n.id === nodeId);

      if (!node) continue;

      // Create tenant_nodes record (cert_status null for registered tenants)
      const result = await db
        .insertInto("tenant_nodes")
        .values({
          tenant_id: tenant.id,
          node_id: nodeId,
          is_primary: isPrimary,
          cert_status: isRegisterOnly ? null : "pending",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Skip provisioning for registered tenants
      if (!isRegisterOnly) {
        if (node.public_ip) {
          const healthCheckId = await createHealthCheck(
            domainInfo,
            node.public_ip,
          );
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
        }

        if (node.status === "active") {
          activeNodeIds.push(nodeId);
        }

        syncToNode(nodeId).catch((err: unknown) => logger.error(String(err)));
      }
    }

    // Skip cert provisioning for registered tenants
    if (!isRegisterOnly && activeNodeIds.length > 0) {
      enqueueCertProvisioning(activeNodeIds, tenant.name, org.slug).catch(
        (err: unknown) =>
          logger.error(`Failed to enqueue cert provisioning: ${err}`),
      );
    }

    // Skip faremeter dash setup for registered tenants
    if (!isRegisterOnly && wallet) {
      const walletConfig = wallet.wallet_config as WalletConfig | null;
      if (walletConfig) {
        const accessToken = Math.random().toString(36).substring(2, 7);
        const addresses = {
          solana: walletConfig.solana?.["mainnet-beta"]?.address,
          base: walletConfig.evm?.base?.address,
          polygon: walletConfig.evm?.polygon?.address,
          monad: walletConfig.evm?.monad?.address,
        };

        setupAccountWithAddresses(tenant.name, accessToken, addresses).catch(
          (err: unknown) =>
            logger.error(
              `Failed to setup faremeter dash account for ${tenant.name}: ${err}`,
            ),
        );
      }
    }

    // Skip status check for registered tenants
    if (!isRegisterOnly) {
      await checkAndUpdateTenantStatus(tenant.id);
    }

    return c.json(tenant, 201);
  },
);

organizationsRoutes.get("/:id/invitations", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const invitations = await db
    .selectFrom("organization_invitations")
    .leftJoin("users", "users.id", "organization_invitations.invited_by")
    .select([
      "organization_invitations.id",
      "organization_invitations.email",
      "organization_invitations.role",
      "organization_invitations.token",
      "organization_invitations.expires_at",
      "organization_invitations.created_at",
      "users.email as invited_by_email",
    ])
    .where("organization_invitations.organization_id", "=", orgId)
    .where("organization_invitations.accepted_at", "is", null)
    .where("organization_invitations.expires_at", ">", new Date())
    .orderBy("organization_invitations.created_at", "desc")
    .execute();

  return c.json(invitations);
});

organizationsRoutes.post(
  "/:id/invitations",
  createResourceLimiter,
  arktypeValidator("json", AddMemberSchema),
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const body = c.req.valid("json");

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (
      membership &&
      !["owner", "admin"].includes(membership.role) &&
      !user.is_admin
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const email = body.email.trim().toLowerCase();

    const existingUser = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();

    if (existingUser) {
      const existingMembership = await db
        .selectFrom("user_organizations")
        .select("id")
        .where("user_id", "=", existingUser.id)
        .where("organization_id", "=", orgId)
        .executeTakeFirst();

      if (existingMembership) {
        return c.json({ error: "User is already a member" }, 409);
      }
    }

    const existingInvitation = await db
      .selectFrom("organization_invitations")
      .select("id")
      .where("organization_id", "=", orgId)
      .where("email", "=", email)
      .where("accepted_at", "is", null)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();

    if (existingInvitation) {
      return c.json(
        { error: "An invitation is already pending for this email" },
        409,
      );
    }

    const role = body.role ?? "member";

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = await db
      .insertInto("organization_invitations")
      .values({
        organization_id: orgId,
        email,
        token,
        role,
        invited_by: user.id,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const org = await db
      .selectFrom("organizations")
      .select(["name"])
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();

    const inviterUser = await db
      .selectFrom("users")
      .select(["email"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    const siteUrl = await getSiteUrl();
    if (siteUrl) {
      const invitationUrl = `${siteUrl}/invite/${token}`;
      enqueueEmail(email, "invitation", {
        invitation_url: invitationUrl,
        organization_name: org.name,
        inviter_email: inviterUser.email,
        role,
      }).catch(() => undefined);
    }

    return c.json(invitation, 201);
  },
);

organizationsRoutes.delete(
  "/:id/invitations/:invitationId",
  modifyResourceLimiter,
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const invitationId = parseInt(c.req.param("invitationId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (
      membership &&
      !["owner", "admin"].includes(membership.role) &&
      !user.is_admin
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    const invitation = await db
      .selectFrom("organization_invitations")
      .select("id")
      .where("id", "=", invitationId)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!invitation) {
      return c.json({ error: "Invitation not found" }, 404);
    }

    await db
      .deleteFrom("organization_invitations")
      .where("id", "=", invitationId)
      .execute();

    return c.json({ deleted: true });
  },
);

organizationsRoutes.get("/:id/onboarding-status", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const org = await db
    .selectFrom("organizations")
    .select(["onboarding_completed", "onboarding_completed_at"])
    .where("id", "=", orgId)
    .executeTakeFirst();

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const walletCount = await db
    .selectFrom("wallets")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("organization_id", "=", orgId)
    .executeTakeFirstOrThrow();

  const fundedWalletCount = await db
    .selectFrom("wallets")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("organization_id", "=", orgId)
    .where("funding_status", "=", "funded")
    .executeTakeFirstOrThrow();

  const firstTenant = await db
    .selectFrom("tenants")
    .select("id")
    .where("organization_id", "=", orgId)
    .orderBy("created_at", "asc")
    .executeTakeFirst();

  const endpointCount = await db
    .selectFrom("endpoints")
    .innerJoin("tenants", "tenants.id", "endpoints.tenant_id")
    .select((eb) => eb.fn.count<number>("endpoints.id").as("count"))
    .where("tenants.organization_id", "=", orgId)
    .where("endpoints.is_active", "=", true)
    .executeTakeFirstOrThrow();

  const steps = {
    wallet: walletCount.count > 0,
    funded: fundedWalletCount.count > 0,
    proxy: !!firstTenant,
    endpoint: endpointCount.count > 0,
  };

  const allStepsComplete =
    steps.wallet && steps.funded && steps.proxy && steps.endpoint;

  return c.json({
    onboarding_completed: org.onboarding_completed,
    onboarding_completed_at: org.onboarding_completed_at,
    steps,
    all_steps_complete: allStepsComplete,
    first_proxy_id: firstTenant?.id ?? null,
  });
});

organizationsRoutes.post("/:id/complete-onboarding", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const walletCount = await db
    .selectFrom("wallets")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("organization_id", "=", orgId)
    .executeTakeFirstOrThrow();

  const fundedWalletCount = await db
    .selectFrom("wallets")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("organization_id", "=", orgId)
    .where("funding_status", "=", "funded")
    .executeTakeFirstOrThrow();

  const tenantCount = await db
    .selectFrom("tenants")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("organization_id", "=", orgId)
    .executeTakeFirstOrThrow();

  const endpointCount = await db
    .selectFrom("endpoints")
    .innerJoin("tenants", "tenants.id", "endpoints.tenant_id")
    .select((eb) => eb.fn.count<number>("endpoints.id").as("count"))
    .where("tenants.organization_id", "=", orgId)
    .where("endpoints.is_active", "=", true)
    .executeTakeFirstOrThrow();

  if (
    walletCount.count === 0 ||
    fundedWalletCount.count === 0 ||
    tenantCount.count === 0 ||
    endpointCount.count === 0
  ) {
    return c.json(
      { error: "All onboarding steps must be completed first" },
      400,
    );
  }

  await db
    .updateTable("organizations")
    .set({
      onboarding_completed: true,
      onboarding_completed_at: new Date(),
    })
    .where("id", "=", orgId)
    .execute();

  return c.json({ success: true });
});

organizationsRoutes.post("/:id/reset-onboarding", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));

  if (!user.is_admin) {
    return c.json({ error: "Admin access required" }, 403);
  }

  await db
    .updateTable("organizations")
    .set({
      onboarding_completed: false,
      onboarding_completed_at: null,
    })
    .where("id", "=", orgId)
    .execute();

  return c.json({ success: true });
});

organizationsRoutes.get("/:id/analytics", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  try {
    const earnings = await getOrganizationEarnings(orgId);
    return c.json(earnings);
  } catch (error) {
    logger.error(`Failed to get organization analytics: ${error}`);
    return c.json({ error: "Failed to get analytics" }, 500);
  }
});

organizationsRoutes.get("/:id/tenants/:tenantId/analytics", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));
  const tenantId = parseInt(c.req.param("tenantId"));

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const tenant = await db
    .selectFrom("tenants")
    .select("id")
    .where("id", "=", tenantId)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  try {
    const earnings = await getTenantEarnings(tenantId);
    return c.json(earnings);
  } catch (error) {
    logger.error(`Failed to get tenant analytics: ${error}`);
    return c.json({ error: "Failed to get analytics" }, 500);
  }
});

organizationsRoutes.get(
  "/:id/tenants/:tenantId/endpoints/:endpointId/analytics",
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const tenantId = parseInt(c.req.param("tenantId"));
    const endpointId = parseInt(c.req.param("endpointId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const endpoint = await db
      .selectFrom("endpoints")
      .innerJoin("tenants", "tenants.id", "endpoints.tenant_id")
      .select("endpoints.id")
      .where("endpoints.id", "=", endpointId)
      .where("endpoints.tenant_id", "=", tenantId)
      .where("tenants.organization_id", "=", orgId)
      .executeTakeFirst();

    if (!endpoint) {
      return c.json({ error: "Endpoint not found" }, 404);
    }

    try {
      const earnings = await getEndpointEarnings(endpointId);
      return c.json(earnings);
    } catch (error) {
      logger.error(`Failed to get endpoint analytics: ${error}`);
      return c.json({ error: "Failed to get analytics" }, 500);
    }
  },
);

organizationsRoutes.get(
  "/:id/tenants/:tenantId/catch-all/analytics",
  async (c) => {
    const user = c.get("user");
    const orgId = parseInt(c.req.param("id"));
    const tenantId = parseInt(c.req.param("tenantId"));

    const membership = await db
      .selectFrom("user_organizations")
      .select("role")
      .where("user_id", "=", user.id)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!membership && !user.is_admin) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const tenant = await db
      .selectFrom("tenants")
      .select("id")
      .where("id", "=", tenantId)
      .where("organization_id", "=", orgId)
      .executeTakeFirst();

    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    try {
      const earnings = await getCatchAllEarnings(tenantId);
      return c.json(earnings);
    } catch (error) {
      logger.error(`Failed to get catch-all analytics: ${error}`);
      return c.json({ error: "Failed to get analytics" }, 500);
    }
  },
);

organizationsRoutes.get("/:id/analytics/earnings", async (c) => {
  const user = c.get("user");
  const orgId = parseInt(c.req.param("id"));
  const level = c.req.query("level") as "organization" | "tenant" | "endpoint";
  const targetIdStr = c.req.query("targetId");
  const granularityParam = c.req.query("granularity") ?? "month";
  const periodsStr = c.req.query("periods");

  const membership = await db
    .selectFrom("user_organizations")
    .select("role")
    .where("user_id", "=", user.id)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();

  if (!membership && !user.is_admin) {
    return c.json({ error: "Organization not found" }, 404);
  }

  if (!level || !["organization", "tenant", "endpoint"].includes(level)) {
    return c.json(
      { error: "Invalid level. Must be organization, tenant, or endpoint" },
      400,
    );
  }

  let targetId = orgId;
  if (level !== "organization") {
    if (!targetIdStr) {
      return c.json(
        { error: "targetId is required for tenant/endpoint level" },
        400,
      );
    }
    targetId = parseInt(targetIdStr);
    if (isNaN(targetId)) {
      return c.json({ error: "Invalid targetId" }, 400);
    }

    if (level === "tenant") {
      const tenant = await db
        .selectFrom("tenants")
        .select("id")
        .where("id", "=", targetId)
        .where("organization_id", "=", orgId)
        .executeTakeFirst();
      if (!tenant) {
        return c.json({ error: "Tenant not found" }, 404);
      }
    } else if (level === "endpoint") {
      const endpoint = await db
        .selectFrom("endpoints")
        .innerJoin("tenants", "tenants.id", "endpoints.tenant_id")
        .select("endpoints.id")
        .where("endpoints.id", "=", targetId)
        .where("tenants.organization_id", "=", orgId)
        .executeTakeFirst();
      if (!endpoint) {
        return c.json({ error: "Endpoint not found" }, 404);
      }
    }
  }

  if (!["day", "week", "month"].includes(granularityParam)) {
    return c.json(
      { error: "Invalid granularity. Must be day, week, or month" },
      400,
    );
  }
  const granularity = granularityParam as Granularity;

  const periods = periodsStr ? parseInt(periodsStr) : 12;
  if (isNaN(periods) || periods < 1 || periods > 365) {
    return c.json({ error: "Invalid periods. Must be between 1 and 365" }, 400);
  }

  try {
    const data = await getEarningsByPeriod(
      level,
      targetId,
      granularity,
      periods,
    );
    return c.json(data);
  } catch (error) {
    logger.error(`Failed to get earnings analytics: ${error}`);
    return c.json({ error: "Failed to get analytics" }, 500);
  }
});
