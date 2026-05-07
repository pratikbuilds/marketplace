import { db } from "../db/instance.js";
import { sql, type SelectQueryBuilder } from "kysely";
import type { Database } from "../db/schema.js";
import { getSymbolToUsdRate } from "./jupiter-prices.js";
import { USD_PEGGED_SYMBOLS } from "./schemas.js";

const usdPeggedSet = new Set<string>(USD_PEGGED_SYMBOLS);

export interface TokenBreakdown {
  symbol: string;
  total: number;
  usdTotal: number;
}

// Adjusts a raw SUM(amount) by converting non-USD token amounts to USD using Jupiter rates.
// For non-USD tokens (e.g. EURC): subtracts raw amount, adds back amount * jupiterRate.
function hasNonUsdTokens(
  tokenSubtotals: { symbol: string; total: number }[],
): boolean {
  return tokenSubtotals.some((t) => !usdPeggedSet.has(t.symbol));
}

function adjustWithRates(
  rawTotal: number,
  tokenSubtotals: { symbol: string; total: number }[],
  rates: Record<string, number>,
): { adjusted: number; breakdown: TokenBreakdown[] } {
  let adjusted = rawTotal;
  const breakdown: TokenBreakdown[] = [];

  for (const { symbol, total } of tokenSubtotals) {
    if (!usdPeggedSet.has(symbol)) {
      // Non-USD token: convert using Jupiter rate
      const rate = rates[symbol];
      const usdTotal = rate ? Math.round(total * rate) : total;
      adjusted = adjusted - total + usdTotal;
      breakdown.push({ symbol, total, usdTotal });
    } else {
      // USD-pegged non-USDC token: no conversion needed, but include in breakdown
      breakdown.push({ symbol, total, usdTotal: total });
    }
  }

  return { adjusted, breakdown };
}

async function getRatesIfNeeded(
  ...subtotalArrays: { symbol: string; total: number }[][]
): Promise<Record<string, number>> {
  for (const arr of subtotalArrays) {
    if (hasNonUsdTokens(arr)) {
      return getSymbolToUsdRate();
    }
  }
  return {};
}

export interface EarningsAnalytics {
  total_earned: number;
  current_month_earned: number;
  previous_month_earned: number;
  percent_change: number | null;
  total_transactions: number;
  token_breakdown?: TokenBreakdown[];
}

export interface MonthlyEarnings {
  month: string;
  total: number;
}

function getMonthBoundaries(): {
  currentMonthStart: Date;
  previousMonthStart: Date;
} {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { currentMonthStart, previousMonthStart };
}

function calculatePercentChange(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

type TransactionsQuery = SelectQueryBuilder<Database, "transactions", object>;
type QueryFilter = (qb: TransactionsQuery) => TransactionsQuery;

async function getFilteredEarnings(
  filter: QueryFilter,
): Promise<EarningsAnalytics> {
  const { currentMonthStart, previousMonthStart } = getMonthBoundaries();

  const toSubs = (rows: { symbol: string; total: number | string }[]) =>
    rows.map((r) => ({ symbol: r.symbol, total: Number(r.total) }));

  const base = () => filter(db.selectFrom("transactions"));

  const [
    totals,
    currentMonth,
    previousMonth,
    breakdown,
    currentBreakdown,
    previousBreakdown,
  ] = await Promise.all([
    base()
      .select([
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
        sql<number>`COUNT(*)`.as("count"),
      ])
      .executeTakeFirst(),

    base()
      .select(sql<number>`COALESCE(SUM(amount), 0)`.as("total"))
      .where("created_at", ">=", currentMonthStart)
      .executeTakeFirst(),

    base()
      .select(sql<number>`COALESCE(SUM(amount), 0)`.as("total"))
      .where("created_at", ">=", previousMonthStart)
      .where("created_at", "<", currentMonthStart)
      .executeTakeFirst(),

    base()
      .select([
        sql<string>`token_symbol`.as("symbol"),
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
      ])
      .where("token_symbol", "is not", null)
      .where("token_symbol", "!=", "USDC")
      .groupBy("token_symbol")
      .execute(),

    base()
      .select([
        sql<string>`token_symbol`.as("symbol"),
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
      ])
      .where("created_at", ">=", currentMonthStart)
      .where("token_symbol", "is not", null)
      .where("token_symbol", "!=", "USDC")
      .groupBy("token_symbol")
      .execute(),

    base()
      .select([
        sql<string>`token_symbol`.as("symbol"),
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
      ])
      .where("created_at", ">=", previousMonthStart)
      .where("created_at", "<", currentMonthStart)
      .where("token_symbol", "is not", null)
      .where("token_symbol", "!=", "USDC")
      .groupBy("token_symbol")
      .execute(),
  ]);

  const rates = await getRatesIfNeeded(
    toSubs(breakdown),
    toSubs(currentBreakdown),
    toSubs(previousBreakdown),
  );

  /* eslint-disable @typescript-eslint/no-unnecessary-type-conversion -- pg driver returns bigint aggregates as strings despite Kysely's sql<number> annotation */
  const { adjusted: totalEarned, breakdown: tokenBreakdown } = adjustWithRates(
    Number(totals?.total ?? 0),
    toSubs(breakdown),
    rates,
  );
  const { adjusted: currentEarned } = adjustWithRates(
    Number(currentMonth?.total ?? 0),
    toSubs(currentBreakdown),
    rates,
  );
  const { adjusted: previousEarned } = adjustWithRates(
    Number(previousMonth?.total ?? 0),
    toSubs(previousBreakdown),
    rates,
  );

  return {
    total_earned: totalEarned,
    current_month_earned: currentEarned,
    previous_month_earned: previousEarned,
    percent_change: calculatePercentChange(currentEarned, previousEarned),
    total_transactions: Number(totals?.count ?? 0),
    /* eslint-enable @typescript-eslint/no-unnecessary-type-conversion */
    token_breakdown: tokenBreakdown,
  };
}

export function getPlatformEarnings(): Promise<EarningsAnalytics> {
  return getFilteredEarnings((qb) => qb);
}

export function getOrganizationEarnings(
  organizationId: number,
): Promise<EarningsAnalytics> {
  return getFilteredEarnings((qb) =>
    qb.where("organization_id", "=", organizationId),
  );
}

export function getTenantEarnings(
  tenantId: number,
): Promise<EarningsAnalytics> {
  return getFilteredEarnings((qb) => qb.where("tenant_id", "=", tenantId));
}

export function getCatchAllEarnings(
  tenantId: number,
): Promise<EarningsAnalytics> {
  return getFilteredEarnings((qb) =>
    qb.where("tenant_id", "=", tenantId).where("endpoint_id", "is", null),
  );
}

export function getEndpointEarnings(
  endpointId: number,
): Promise<EarningsAnalytics> {
  return getFilteredEarnings((qb) => qb.where("endpoint_id", "=", endpointId));
}

export type Granularity = "day" | "week" | "month";

export interface PeriodEarnings {
  period: string;
  total: number;
  call_count: number;
}

const GRANULARITY_FORMAT: Record<Granularity, string> = {
  day: "YYYY-MM-DD",
  week: "IYYY-IW",
  month: "YYYY-MM",
};

export async function getEarningsByPeriod(
  level: "organization" | "tenant" | "endpoint",
  id: number,
  granularity: Granularity = "month",
  periods = 12,
): Promise<PeriodEarnings[]> {
  const column =
    level === "organization"
      ? "organization_id"
      : level === "tenant"
        ? "tenant_id"
        : "endpoint_id";

  const format = GRANULARITY_FORMAT[granularity];

  const startDate = new Date();
  if (granularity === "day") {
    startDate.setDate(startDate.getDate() - periods);
  } else if (granularity === "week") {
    startDate.setDate(startDate.getDate() - periods * 7);
  } else {
    startDate.setMonth(startDate.getMonth() - periods);
  }

  const [result, nonUsdByPeriod] = await Promise.all([
    db
      .selectFrom("transactions")
      .select([
        sql<string>`TO_CHAR(created_at, ${sql.lit(format)})`.as("period"),
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
        sql<number>`COUNT(*)`.as("call_count"),
      ])
      .where(column, "=", id)
      .where("created_at", ">=", startDate)
      .groupBy(sql`1`)
      .orderBy(sql`1`, "asc")
      .execute(),

    db
      .selectFrom("transactions")
      .select([
        sql<string>`TO_CHAR(created_at, ${sql.lit(format)})`.as("period"),
        sql<string>`token_symbol`.as("symbol"),
        sql<number>`COALESCE(SUM(amount), 0)`.as("total"),
      ])
      .where(column, "=", id)
      .where("created_at", ">=", startDate)
      .where("token_symbol", "is not", null)
      .where("token_symbol", "!=", "USDC")
      .groupBy(sql`1`)
      .groupBy("token_symbol")
      .execute(),
  ]);

  // Build per-period adjustment map
  const nonUsdSubs = nonUsdByPeriod.filter((r) => !usdPeggedSet.has(r.symbol));

  let rates: Record<string, number> = {};
  if (nonUsdSubs.length > 0) {
    rates = await getSymbolToUsdRate();
  }

  const periodAdjustments = new Map<string, number>();
  for (const r of nonUsdSubs) {
    const raw = Number(r.total); // eslint-disable-line @typescript-eslint/no-unnecessary-type-conversion -- pg driver returns bigint aggregates as strings
    const rate = rates[r.symbol];
    const converted = rate ? Math.round(raw * rate) : raw;
    const diff = converted - raw;
    periodAdjustments.set(
      r.period,
      (periodAdjustments.get(r.period) ?? 0) + diff,
    );
  }

  /* eslint-disable @typescript-eslint/no-unnecessary-type-conversion -- pg driver returns bigint aggregates as strings */
  return result.map((r) => ({
    period: r.period,
    total: Number(r.total) + (periodAdjustments.get(r.period) ?? 0),
    call_count: Number(r.call_count),
  }));
  /* eslint-enable @typescript-eslint/no-unnecessary-type-conversion */
}
