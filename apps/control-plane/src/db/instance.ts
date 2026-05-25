import "dotenv/config";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import type { Database } from "./schema.js";
import { SqliteAdapterPlugin } from "./plugins/sqlite-adapter.js";

const isTest = process.env.NODE_ENV === "test";

let db: Kysely<Database>;

if (isTest) {
  const Database = (await import("better-sqlite3")).default;
  const sqliteDb = new Database(":memory:");
  sqliteDb.pragma("foreign_keys = ON");

  // Emulate PostgreSQL's TO_CHAR function for date formatting
  sqliteDb.function("TO_CHAR", (dateStr: string, format: string) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const formatMap: Record<string, () => string> = {
      "YYYY-MM-DD": () =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      "YYYY-MM": () =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      "IYYY-IW": () => {
        // ISO week number calculation
        const d = new Date(
          Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
        );
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil(
          ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
        );
        return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, "0")}`;
      },
    };

    const formatter = formatMap[format];
    return formatter ? formatter() : dateStr;
  });

  db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqliteDb }),
    plugins: [new SqliteAdapterPlugin()],
  });
} else {
  if (!process.env.DATABASE_PASSWORD) {
    throw new Error("DATABASE_PASSWORD environment variable is required");
  }

  const pkg = await import("pg");
  const { Pool } = pkg.default;

  const dialect = new PostgresDialect({
    pool: new Pool({
      host: process.env.DATABASE_HOST ?? "localhost",
      port: parseInt(process.env.DATABASE_PORT ?? "5432"),
      database: process.env.DATABASE_NAME ?? "control_plane",
      user: process.env.DATABASE_USER ?? "control_plane",
      password: process.env.DATABASE_PASSWORD,
      max: 10,
      ssl:
        process.env.DATABASE_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    }),
  });

  db = new Kysely<Database>({ dialect });
}

export { db };

export async function setupTestSchema(): Promise<void> {
  if (!isTest) return;

  await db.schema
    .createTable("organizations")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("is_admin", "integer", (col) => col.defaultTo(0))
    .addColumn("onboarding_completed", "integer", (col) => col.defaultTo(0))
    .addColumn("onboarding_completed_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("password_hash", "text", (col) => col.notNull())
    .addColumn("is_admin", "integer", (col) => col.defaultTo(0))
    .addColumn("email_verified", "integer", (col) => col.defaultTo(0))
    .addColumn("verification_token", "text")
    .addColumn("verification_expires", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("user_organizations")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("user_id", "integer", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "integer", (col) =>
      col.notNull().references("organizations.id").onDelete("cascade"),
    )
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("joined_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("organization_invitations")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("organization_id", "integer", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.defaultTo("member"))
    .addColumn("invited_by", "integer")
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("accepted_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("nodes")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("internal_ip", "text", (col) => col.notNull())
    .addColumn("public_ip", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("wireguard_public_key", "text")
    .addColumn("wireguard_address", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("wallets")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("organization_id", "integer")
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("wallet_config", "text", (col) => col.notNull())
    .addColumn("funding_status", "text", (col) => col.defaultTo("pending"))
    .addColumn("cached_balances", "text")
    .addColumn("balances_cached_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("tenants")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("backend_url", "text", (col) => col.notNull())
    .addColumn("organization_id", "integer", (col) =>
      col.references("organizations.id").onDelete("set null"),
    )
    .addColumn("wallet_id", "integer", (col) =>
      col.references("wallets.id").onDelete("set null"),
    )
    .addColumn("status", "text", (col) => col.defaultTo("pending"))
    .addColumn("default_price", "real", (col) => col.notNull())
    .addColumn("default_scheme", "text", (col) => col.notNull())
    .addColumn("upstream_auth_header", "text")
    .addColumn("upstream_auth_value", "text")
    .addColumn("openapi_spec", "text")
    .addColumn("is_active", "integer", (col) => col.defaultTo(1))
    .addColumn("org_slug", "text")
    .addColumn("tags", "text", (col) => col.defaultTo("[]"))
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("tenant_nodes")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("tenant_id", "integer", (col) => col.notNull())
    .addColumn("node_id", "integer", (col) => col.notNull())
    .addColumn("is_primary", "integer", (col) => col.defaultTo(0))
    .addColumn("health_check_id", "text")
    .addColumn("cert_status", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("endpoints")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("tenant_id", "integer", (col) => col.notNull())
    .addColumn("path", "text")
    .addColumn("path_pattern", "text", (col) => col.notNull())
    .addColumn("http_method", "text", (col) => col.defaultTo("ANY").notNull())
    .addColumn("price", "real")
    .addColumn("scheme", "text")
    .addColumn("description", "text")
    .addColumn("priority", "integer", (col) => col.defaultTo(0))
    .addColumn("openapi_source_paths", "text")
    .addColumn("is_active", "integer", (col) => col.defaultTo(1))
    .addColumn("tags", "text", (col) => col.defaultTo("[]"))
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .addColumn("deleted_at", "text")
    .execute();

  await db.schema
    .createTable("transactions")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("endpoint_id", "integer")
    .addColumn("tenant_id", "integer", (col) => col.notNull())
    .addColumn("organization_id", "integer")
    .addColumn("amount", "real", (col) => col.notNull())
    .addColumn("ngx_request_id", "text", (col) => col.notNull())
    .addColumn("tx_hash", "text")
    .addColumn("network", "text")
    .addColumn("token_symbol", "text")
    .addColumn("mint_address", "text")
    .addColumn("request_path", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("admin_settings")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("wallet_config", "text")
    .addColumn("minimum_balance_sol", "real", (col) => col.defaultTo(0.001))
    .addColumn("minimum_balance_usdc", "real", (col) => col.defaultTo(0.01))
    .addColumn("email_config", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .addColumn("updated_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("waitlist")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("whitelisted", "integer", (col) => col.defaultTo(0))
    .addColumn("signed_up", "integer", (col) => col.defaultTo(0))
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("password_reset_tokens")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("user_id", "integer", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  // Production uses bigint for amount; SQLite integer is 64-bit so functionally equivalent
  await db.schema
    .createTable("token_prices")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("tenant_id", "integer", (col) => col.notNull())
    .addColumn("endpoint_id", "integer")
    .addColumn("token_symbol", "text", (col) => col.notNull())
    .addColumn("mint_address", "text", (col) => col.notNull())
    .addColumn("network", "text", (col) => col.notNull())
    .addColumn("amount", "integer", (col) => col.notNull())
    .addColumn("decimals", "integer", (col) => col.defaultTo(6))
    .addColumn("payout_splits", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .addColumn("updated_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  await db.schema
    .createTable("supported_tokens")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("symbol", "text", (col) => col.notNull())
    .addColumn("mint_address", "text", (col) => col.notNull())
    .addColumn("network", "text", (col) => col.notNull())
    .addColumn("is_usd_pegged", "integer", (col) => col.defaultTo(1))
    .addColumn("decimals", "integer", (col) => col.defaultTo(6))
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  // Seed reference data — supported_tokens is not cleared between tests
  await db
    .insertInto("supported_tokens")
    .values([
      {
        symbol: "USDC",
        mint_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        network: "solana-mainnet-beta",
        is_usd_pegged: true,
      },
      {
        symbol: "USDT",
        mint_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        network: "solana-mainnet-beta",
        is_usd_pegged: true,
      },
      {
        symbol: "EURC",
        mint_address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        network: "solana-mainnet-beta",
        is_usd_pegged: false,
      },
      {
        symbol: "USDC",
        mint_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        network: "base",
        is_usd_pegged: true,
      },
    ])
    .execute();

  await db.schema
    .createTable("discovery_telemetry")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("event_type", "text", (col) => col.notNull())
    .addColumn("event_key", "text")
    .addColumn("proxy_id", "integer")
    .addColumn("endpoint_id", "integer")
    .addColumn("bucket", "text", (col) => col.notNull())
    .addColumn("count", "integer", (col) => col.defaultTo(1))
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .addColumn("updated_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();
}

export async function clearTestData(): Promise<void> {
  if (!isTest) return;

  await db.deleteFrom("transactions").execute();
  await db.deleteFrom("endpoints").execute();
  await db.deleteFrom("tenant_nodes").execute();
  await db.deleteFrom("tenants").execute();
  await db.deleteFrom("wallets").execute();
  await db.deleteFrom("nodes").execute();
  await db.deleteFrom("organization_invitations").execute();
  await db.deleteFrom("password_reset_tokens").execute();
  await db.deleteFrom("user_organizations").execute();
  await db.deleteFrom("users").execute();
  await db.deleteFrom("organizations").execute();
  await db.deleteFrom("admin_settings").execute();
  await db.deleteFrom("waitlist").execute();
  await db.deleteFrom("token_prices").execute();
  await db.deleteFrom("discovery_telemetry").execute();
}
