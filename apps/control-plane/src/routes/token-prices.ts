import { Hono } from "hono";
import { db } from "../db/instance.js";
import { arktypeValidator } from "@hono/arktype-validator";
import {
  CreateTokenPriceSchema,
  UpdateTokenPriceSchema,
} from "../lib/schemas.js";
import { syncTenantNodes } from "../lib/sync.js";
import { requireTenantAccess } from "../middleware/auth.js";
import {
  createResourceLimiter,
  modifyResourceLimiter,
} from "../middleware/rate-limit.js";

export const tokenPricesRoutes = new Hono();

tokenPricesRoutes.use("*", requireTenantAccess);

tokenPricesRoutes.get("/", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");
  const endpointId = c.req.query("endpoint_id");

  let query = db
    .selectFrom("token_prices")
    .selectAll()
    .where("tenant_id", "=", tenantId);

  if (endpointId) {
    query = query.where("endpoint_id", "=", parseInt(endpointId));
  } else {
    query = query.where("endpoint_id", "is", null);
  }

  const prices = await query.orderBy("token_symbol", "asc").execute();

  return c.json({ data: prices });
});

tokenPricesRoutes.get("/:id", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");
  const id = parseInt(c.req.param("id") ?? "");

  const price = await db
    .selectFrom("token_prices")
    .selectAll()
    .where("id", "=", id)
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();

  if (!price) {
    return c.json({ error: "Token price not found" }, 404);
  }

  return c.json(price);
});

tokenPricesRoutes.post(
  "/",
  createResourceLimiter,
  arktypeValidator("json", CreateTokenPriceSchema),
  async (c) => {
    const tenantId = parseInt(c.req.param("tenantId") ?? "");
    const body = c.req.valid("json");

    const endpointId = body.endpoint_id ?? null;

    if (endpointId !== null) {
      const endpoint = await db
        .selectFrom("endpoints")
        .select("id")
        .where("id", "=", endpointId)
        .where("tenant_id", "=", tenantId)
        .executeTakeFirst();

      if (!endpoint) {
        return c.json({ error: "Endpoint does not belong to tenant" }, 400);
      }
    }

    const existing = await db
      .selectFrom("token_prices")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("token_symbol", "=", body.token_symbol)
      .where("network", "=", body.network)
      .$if(endpointId !== null, (qb) =>
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        qb.where("endpoint_id", "=", endpointId!),
      )
      .$if(endpointId === null, (qb) => qb.where("endpoint_id", "is", null))
      .executeTakeFirst();

    if (existing) {
      return c.json(
        {
          error: `Token price already exists for ${body.token_symbol} on ${body.network}`,
        },
        409,
      );
    }

    const result = await db
      .insertInto("token_prices")
      .values({
        tenant_id: tenantId,
        endpoint_id: endpointId,
        token_symbol: body.token_symbol,
        mint_address: body.mint_address,
        network: body.network,
        amount: body.amount,
        decimals: body.decimals ?? 6,
      })
      .returningAll()
      .executeTakeFirst();

    void syncTenantNodes(tenantId);

    return c.json(result, 201);
  },
);

tokenPricesRoutes.put(
  "/:id",
  modifyResourceLimiter,
  arktypeValidator("json", UpdateTokenPriceSchema),
  async (c) => {
    const tenantId = parseInt(c.req.param("tenantId") ?? "");
    const id = parseInt(c.req.param("id") ?? "");
    const body = c.req.valid("json");

    const updateData: Record<string, unknown> = {};
    if (body.amount !== undefined) updateData.amount = body.amount;
    if (body.decimals !== undefined) updateData.decimals = body.decimals;

    if (Object.keys(updateData).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    updateData.updated_at = new Date();

    const result = await db
      .updateTable("token_prices")
      .set(updateData)
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      return c.json({ error: "Token price not found" }, 404);
    }

    void syncTenantNodes(tenantId);

    return c.json(result);
  },
);

tokenPricesRoutes.delete("/:id", modifyResourceLimiter, async (c) => {
  const tenantId = parseInt(c.req.param("tenantId") ?? "");
  const id = parseInt(c.req.param("id") ?? "");

  const result = await db
    .deleteFrom("token_prices")
    .where("id", "=", id)
    .where("tenant_id", "=", tenantId)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    return c.json({ error: "Token price not found" }, 404);
  }

  void syncTenantNodes(tenantId);

  return c.json({ success: true });
});
