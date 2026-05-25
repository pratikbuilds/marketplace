import { Kysely, SqliteDialect, sql } from "kysely";
import Database from "better-sqlite3";
import type { Database as DatabaseSchema } from "@1click/db-schema";

export function createTestDatabase(): Kysely<DatabaseSchema> {
  const sqliteDb = new Database(":memory:");
  const dialect = new SqliteDialect({ database: sqliteDb });
  return new Kysely<DatabaseSchema>({ dialect });
}

export async function setupTestSchema(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  // Create tables in order (respecting foreign key dependencies)

  // Organizations table
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

  // Users table
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

  // User organizations table
  await db.schema
    .createTable("user_organizations")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("user_id", "integer", (col) => col.notNull())
    .addColumn("organization_id", "integer", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("joined_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  // Organization invitations table
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

  // Nodes table
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

  // Wallets table
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

  // Tenants table
  await db.schema
    .createTable("tenants")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("backend_url", "text", (col) => col.notNull())
    .addColumn("organization_id", "integer")
    .addColumn("wallet_id", "integer")
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

  // Tenant nodes table
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

  // Endpoints table
  await db.schema
    .createTable("endpoints")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("tenant_id", "integer", (col) => col.notNull())
    .addColumn("path", "text")
    .addColumn("path_pattern", "text", (col) => col.notNull())
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

  // Transactions table
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
    .addColumn("client_ip", "text")
    .addColumn("request_method", "text")
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  // Admin settings table
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

  // Waitlist table
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

  // Password reset tokens table
  await db.schema
    .createTable("password_reset_tokens")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("user_id", "integer", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull(),
    )
    .execute();

  // Token prices table (production uses bigint for amount; SQLite integer is 64-bit so equivalent)
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

  // Supported tokens table
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

  // Discovery telemetry table
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

export async function teardownTestDatabase(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await db.destroy();
}
