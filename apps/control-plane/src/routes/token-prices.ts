import { Hono } from "hono";
import { db } from "../db/instance.js";
import { arktypeValidator } from "@hono/arktype-validator";
import {
  CreateTokenPriceSchema,
  UpdateTokenPriceSchema,
} from "../lib/schemas.js";
import { syncToNode } from "../lib/sync.js";
import { logger } from "../logger.js";
import { requireTenantAccess } from "../middleware/auth.js";
import {
  createResourceLimiter,
  modifyResourceLimiter,
} from "../middleware/rate-limit.js";

const SPLIT_BPS_TOTAL = 10_000;

type PayoutSplit = {
  recipient: string;
  bps: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayoutSplits(value: unknown): PayoutSplit[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    return parsePayoutSplits(JSON.parse(value));
  }
  if (!Array.isArray(value)) {
    throw new Error("payout_splits must be an array");
  }
  if (value.length === 0) {
    throw new Error("payout_splits must not be empty");
  }

  let totalBps = 0;
  const splits: PayoutSplit[] = [];
  for (const [index, split] of value.entries()) {
    if (!isRecord(split)) {
      throw new Error(`payout_splits[${index}] must be an object`);
    }
    if (typeof split.recipient !== "string" || split.recipient.trim() === "") {
      throw new Error(
        `payout_splits[${index}].recipient must be a non-empty string`,
      );
    }
    if (
      typeof split.bps !== "number" ||
      !Number.isInteger(split.bps) ||
      split.bps <= 0
    ) {
      throw new Error(`payout_splits[${index}].bps must be a positive integer`);
    }
    totalBps += split.bps;
    splits.push({ recipient: split.recipient.trim(), bps: split.bps });
  }

  if (totalBps !== SPLIT_BPS_TOTAL) {
    throw new Error(
      `payout_splits bps must sum to ${SPLIT_BPS_TOTAL}, got ${totalBps}`,
    );
  }

  return splits;
}

function serializePayoutSplits(value: unknown): string | null {
  const splits = parsePayoutSplits(value);
  return splits ? JSON.stringify(splits) : null;
}

function normalizeTokenPrice<T extends { payout_splits: unknown }>(row: T) {
  return { ...row, payout_splits: parsePayoutSplits(row.payout_splits) };
}

async function syncTenantNodes(tenantId: number) {
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

  return c.json({ data: prices.map(normalizeTokenPrice) });
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

  return c.json(normalizeTokenPrice(price));
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

    let payoutSplits: string | null;
    try {
      payoutSplits = serializePayoutSplits(body.payout_splits);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
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
        payout_splits: payoutSplits,
      })
      .returningAll()
      .executeTakeFirst();

    void syncTenantNodes(tenantId);

    return c.json(result ? normalizeTokenPrice(result) : result, 201);
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
    if (body.payout_splits !== undefined) {
      try {
        updateData.payout_splits = serializePayoutSplits(body.payout_splits);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    }

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

    return c.json(normalizeTokenPrice(result));
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
