import "../tests/setup/env.js";
import t from "tap";
import { type } from "arktype";
import { Hono } from "hono";
import { sql } from "kysely";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { signToken } from "../middleware/auth.js";
import { adminRoutes } from "./admin.js";
import {
  enableFaremeterMock,
  disableFaremeterMock,
} from "../tests/setup/faremeter-mock.js";

const ErrorResponse = type({ error: "string", "+": "delete" });
const DeleteResponse = type({ deleted: "boolean", "+": "delete" });
const AvailabilityResponse = type({ available: "boolean", "+": "delete" });

const UserResponse = type({
  email: "string",
  is_admin: "boolean",
  email_verified: "boolean",
  "organizations?": type({
    id: "number",
    name: "string",
    slug: "string",
    role: "string",
    "+": "delete",
  }).array(),
  "+": "delete",
});

const OrgDetailResponse = type({
  name: "string",
  slug: "string",
  "members?": "unknown[]",
  "tenants?": "unknown[]",
  "+": "delete",
});

const BulkCreateResponse = type({
  created: type({ slug: "string", name: "string", "+": "delete" }).array(),
  failed: "unknown[]",
  skipped: type({ name: "string", "+": "delete" }).array(),
  "+": "delete",
});

const CheckSlugsResponse = type({
  existing: "string[]",
  "+": "delete",
});

const TenantResponse = type({
  id: "number",
  name: "string",
  "status?": "string",
  "tags?": "string[]",
  "backend_url?": "string",
  "wallet_id?": "number | null",
  "is_active?": "boolean",
  "+": "delete",
});

const NodeAssignResponse = type({
  success: "boolean",
  "is_primary?": "boolean",
  "+": "delete",
});

const EndpointResponse = type({
  id: "number",
  "path?": "string",
  "path_pattern?": "string",
  "price?": "number | null",
  "+": "delete",
});

const TransactionsResponse = type({
  transactions: "unknown[]",
  "total?": "number",
  "limit?": "number",
  "offset?": "number",
  "error?": "string",
  "+": "delete",
});

const ActivateResponse = type({
  success: "boolean",
  status: "string",
  "+": "delete",
});

const CertStatusItem = type({
  id: "number",
  tenant_name: "string",
  node_name: "string",
  node_id: "number",
  "cert_status?": "string | null",
  "is_primary?": "boolean",
  "+": "delete",
});

const HealthResponse = type({
  healthy: "boolean",
  "dev?": "boolean",
  "+": "delete",
});

const PlatformStatsResponse = type({
  users: "number",
  organizations: "number",
  tenants: "number",
  nodes: "number",
  transactions: "number",
  "+": "delete",
});

const MinBalanceResponse = type({
  minimumBalanceSol: "number",
  minimumBalanceUsdc: "number",
  hasWallet: "boolean",
  "+": "delete",
});

const WhitelistResponse = type({
  whitelisted: "number | boolean",
  "+": "delete",
});

const TemplateIds = type({
  verification: "number",
  welcome: "number",
  invitation: "number",
  password_reset: "number",
  "+": "delete",
});

const EmailConfigResponse = type({
  configured: "boolean",
  "from_email?": "string | null",
  "site_url?": "string | null",
  "template_ids?": TemplateIds.or(type("null")),
  "+": "delete",
});

const AdminListItem = type({
  name: "string",
  "tags?": "string[]",
  "tenant_count?": "number",
  "cert_status?": "string | null",
  "wallet_id?": "number | null",
  "is_primary?": "boolean",
  "member_count?": "number",
  "nodes?": "unknown[]",
  "+": "delete",
});

const app = new Hono();
app.route("/api/admin", adminRoutes);

await setupTestSchema();
enableFaremeterMock();
t.teardown(() => disableFaremeterMock());

interface TestUser {
  id: number;
  token: string;
}

async function createUser(email: string, isAdmin = false): Promise<TestUser> {
  const user = await db
    .insertInto("users")
    .values({
      email,
      password_hash: "hash",
      is_admin: isAdmin,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  const token = signToken({ userId: user.id, email: user.email, isAdmin });
  return { id: user.id, token };
}

async function createOrg(name: string, slug: string) {
  return db
    .insertInto("organizations")
    .values({ name, slug })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createTenant(
  orgId: number | null,
  name: string,
  opts: {
    wallet_id?: number;
    status?: string;
    org_slug?: string;
    backend_url?: string;
  } = {},
) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: opts.backend_url ?? "http://backend.example.com",
      default_price: 0.01,
      default_scheme: "exact",
      wallet_id: opts.wallet_id ?? null,
      status: opts.status ?? "active",
      org_slug: opts.org_slug ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createWallet(orgId: number | null, name: string) {
  return db
    .insertInto("wallets")
    .values({
      name,
      organization_id: orgId,
      funding_status: "funded",
      wallet_config: JSON.stringify({
        solana: { "mainnet-beta": { address: "abc123" } },
      }),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createNode(
  name: string,
  opts: { internal_ip?: string; status?: string } = {},
) {
  return db
    .insertInto("nodes")
    .values({
      name,
      internal_ip: opts.internal_ip ?? "10.0.0.1",
      status: opts.status ?? "active",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function addMember(userId: number, orgId: number, role = "member") {
  await db
    .insertInto("user_organizations")
    .values({ user_id: userId, organization_id: orgId, role })
    .execute();
}

async function createEndpoint(
  tenantId: number,
  path: string,
  opts: { priority?: number } = {},
) {
  return db
    .insertInto("endpoints")
    .values({
      tenant_id: tenantId,
      path,
      path_pattern: `^${path}$`,
      priority: opts.priority ?? 0,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createAdminSettings() {
  await sql`
    INSERT OR REPLACE INTO admin_settings (id, minimum_balance_sol, minimum_balance_usdc)
    VALUES (1, 0.1, 10)
  `.execute(db);
}

async function addToWaitlist(
  email: string,
  opts?: { whitelisted?: boolean; signed_up?: boolean },
) {
  return db
    .insertInto("waitlist")
    .values({
      email,
      whitelisted: opts?.whitelisted ?? false,
      signed_up: opts?.signed_up ?? false,
    })
    .returning(["id", "whitelisted", "signed_up"])
    .executeTakeFirstOrThrow();
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("admin routes require authentication", async (t) => {
  const res = await app.request("/api/admin/users");
  t.equal(res.status, 401);
});

await t.test("admin routes reject non-admin users", async (t) => {
  const user = await createUser("user@example.com", false);
  const res = await app.request("/api/admin/users", {
    headers: { Cookie: `auth_token=${user.token}` },
  });
  t.equal(res.status, 403);
});

await t.test("GET /api/admin/users", async (t) => {
  await t.test("returns list of users for admin", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createUser("user1@example.com");
    await createUser("user2@example.com");

    const res = await app.request("/api/admin/users", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 3);
  });
});

await t.test("GET /api/admin/users/:id", async (t) => {
  await t.test("returns user with organizations", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id, "owner");

    const res = await app.request(`/api/admin/users/${user.id}`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = UserResponse.assert(await res.json());
    t.equal(data.email, "user@example.com");
    if (!data.organizations) throw new Error("expected organizations");
    t.equal(data.organizations.length, 1);
    if (!data.organizations[0]) throw new Error("expected organizations[0]");
    t.equal(data.organizations[0].role, "owner");
  });

  await t.test("returns 404 for non-existent user", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/users/999", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("PUT /api/admin/users/:id", async (t) => {
  await t.test("updates user is_admin flag", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");

    const res = await app.request(`/api/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ is_admin: true }),
    });
    t.equal(res.status, 200);
    const data = UserResponse.assert(await res.json());
    t.equal(data.is_admin, true);
  });

  await t.test("updates email_verified flag", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");

    const res = await app.request(`/api/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email_verified: true }),
    });
    t.equal(res.status, 200);
    const data = UserResponse.assert(await res.json());
    t.equal(data.email_verified, true);
  });

  await t.test("returns 404 for non-existent user", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/users/999", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ is_admin: true }),
    });
    t.equal(res.status, 404);
  });
});

await t.test("DELETE /api/admin/users/:id", async (t) => {
  await t.test("deletes user", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");

    const res = await app.request(`/api/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);
  });

  await t.test("prevents admin from deleting themselves", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request(`/api/admin/users/${admin.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("yourself"));
  });

  await t.test("returns 404 for non-existent user", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/users/999", {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("GET /api/admin/organizations", async (t) => {
  await t.test("returns list of organizations with counts", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    await createTenant(org.id, "tenant-1");
    await createTenant(org.id, "tenant-2");

    const res = await app.request("/api/admin/organizations", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].name, "Team");
    t.equal(data[0].member_count, 1);
    t.equal(data[0].tenant_count, 2);
  });
});

await t.test("GET /api/admin/organizations/:id", async (t) => {
  await t.test("returns organization with members and tenants", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const user = await createUser("user@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id, "owner");
    await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/organizations/${org.id}`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = OrgDetailResponse.assert(await res.json());
    t.equal(data.name, "Team");
    if (!data.members) throw new Error("expected members");
    if (!data.tenants) throw new Error("expected tenants");
    t.equal(data.members.length, 1);
    t.equal(data.tenants.length, 1);
  });

  await t.test("returns 404 for non-existent org", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/999", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("POST /api/admin/organizations", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Org" }),
    });
    t.equal(res.status, 401);
  });

  await t.test("returns 403 for non-admin user", async (t) => {
    const user = await createUser("user@example.com", false);
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Test Org" }),
    });
    t.equal(res.status, 403);
  });

  await t.test("creates organization", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "New Org" }),
    });
    t.equal(res.status, 201);
    const data = OrgDetailResponse.assert(await res.json());
    t.equal(data.name, "New Org");
    t.equal(data.slug, "new-org");
  });

  await t.test("creates organization with custom slug", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Custom Org", slug: "my-custom-slug" }),
    });
    t.equal(res.status, 201);
    const data = OrgDetailResponse.assert(await res.json());
    t.equal(data.name, "Custom Org");
    t.equal(data.slug, "my-custom-slug");
  });

  await t.test("generates unique slug on conflict", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createOrg("Existing", "existing-org");
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Existing Org" }),
    });
    t.equal(res.status, 201);
    const data = OrgDetailResponse.assert(await res.json());
    t.equal(data.name, "Existing Org");
    t.ok(data.slug.startsWith("existing-org-"));
  });

  await t.test("returns 400 for missing name", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    t.equal(res.status, 400);
  });
});

await t.test("POST /api/admin/organizations/import", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["Test Org"] }),
    });
    t.equal(res.status, 401);
  });

  await t.test("returns 403 for non-admin user", async (t) => {
    const user = await createUser("user@example.com", false);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test Org"] }),
    });
    t.equal(res.status, 403);
  });

  await t.test("imports single organization", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test Org"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    t.equal(data.failed.length, 0);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].name, "Test Org");
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "test-org");
  });

  await t.test("imports multiple organizations", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Org One", "Org Two", "Org Three"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 3);
    t.equal(data.failed.length, 0);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "org-one");
    if (!data.created[1]) throw new Error("expected data.created[1]");
    t.equal(data.created[1].slug, "org-two");
    if (!data.created[2]) throw new Error("expected data.created[2]");
    t.equal(data.created[2].slug, "org-three");
  });

  await t.test("converts periods to dashes in slug", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["My.Company.Name"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "my-company-name");
  });

  await t.test("converts spaces to dashes in slug", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["My Company Name"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "my-company-name");
  });

  await t.test("handles slug collision by appending suffix", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createOrg("Existing Org", "existing-org");

    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Existing Org"], skip_duplicates: false }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.ok(data.created[0].slug.startsWith("existing-org-"));
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug.length, "existing-org-".length + 4);
  });

  await t.test("rejects name shorter than 4 chars", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["abc"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name longer than 58 chars", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const longName = "a".repeat(59);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: [longName] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name with invalid characters", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test@Org!"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name with consecutive spaces", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test  Org"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name with consecutive periods", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test..Org"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name starting with hyphen", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["-Test Org"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name ending with hyphen", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test Org-"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name starting with period", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: [".Test Org"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects name ending with period", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Test Org."] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("returns empty arrays for empty input", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: [] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 0);
    t.equal(data.failed.length, 0);
  });

  await t.test("handles mixed valid and invalid in same batch", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        names: ["Valid Org", "ab", "Another Valid", "Test..Bad"],
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test(
    "handles names that produce same slug in same batch",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/organizations/import", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          names: ["My Org", "My.Org"],
          skip_duplicates: false,
        }),
      });
      t.equal(res.status, 200);
      const data = BulkCreateResponse.assert(await res.json());
      t.equal(data.created.length, 2);
      if (!data.created[0]) throw new Error("expected data.created[0]");
      t.equal(data.created[0].slug, "my-org");
      if (!data.created[1]) throw new Error("expected data.created[1]");
      t.ok(data.created[1].slug.startsWith("my-org-"));
    },
  );

  await t.test("accepts name with period-hyphen combination", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["My.-Org"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "my-org");
  });

  await t.test("accepts name at minimum length (4 chars)", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Abcd"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
    if (!data.created[0]) throw new Error("expected data.created[0]");
    t.equal(data.created[0].slug, "abcd");
  });

  await t.test("accepts name at maximum length (58 chars)", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const name = "a".repeat(58);
    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: [name] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 1);
  });

  await t.test("persists organizations to database", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Persisted Org"] }),
    });

    const org = await db
      .selectFrom("organizations")
      .selectAll()
      .where("slug", "=", "persisted-org")
      .executeTakeFirst();

    t.ok(org);
    t.equal(org?.name, "Persisted Org");
  });

  await t.test("handles multiple slug collisions sequentially", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createOrg("Same Name", "same-name");

    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        names: ["Same Name", "Same Name", "Same Name"],
        skip_duplicates: false,
      }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 3);

    const slugs = data.created.map((c: { slug: string }) => c.slug);
    const uniqueSlugs = new Set(slugs);
    t.equal(uniqueSlugs.size, 3);
  });

  await t.test(
    "skips existing orgs when skip_duplicates is true",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      await createOrg("Existing Org", "existing-org");

      const res = await app.request("/api/admin/organizations/import", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          names: ["Existing Org", "New Org"],
          skip_duplicates: true,
        }),
      });
      t.equal(res.status, 200);
      const data = BulkCreateResponse.assert(await res.json());
      t.equal(data.created.length, 1);
      t.equal(data.skipped.length, 1);
      if (!data.skipped[0]) throw new Error("expected data.skipped[0]");
      t.equal(data.skipped[0].name, "Existing Org");
      if (!data.created[0]) throw new Error("expected data.created[0]");
      t.equal(data.created[0].name, "New Org");
    },
  );

  await t.test(
    "creates orgs with suffix when skip_duplicates is false",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      await createOrg("Existing Org", "existing-org");

      const res = await app.request("/api/admin/organizations/import", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          names: ["Existing Org"],
          skip_duplicates: false,
        }),
      });
      t.equal(res.status, 200);
      const data = BulkCreateResponse.assert(await res.json());
      t.equal(data.created.length, 1);
      t.equal(data.skipped.length, 0);
      if (!data.created[0]) throw new Error("expected data.created[0]");
      t.ok(data.created[0].slug.startsWith("existing-org-"));
    },
  );

  await t.test("skip_duplicates defaults to true", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createOrg("Default Skip", "default-skip");

    const res = await app.request("/api/admin/organizations/import", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names: ["Default Skip"] }),
    });
    t.equal(res.status, 200);
    const data = BulkCreateResponse.assert(await res.json());
    t.equal(data.created.length, 0);
    t.equal(data.skipped.length, 1);
  });
});

await t.test("POST /api/admin/organizations/check-slugs", async (t) => {
  await t.test("returns existing slugs", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createOrg("Org One", "org-one");
    await createOrg("Org Two", "org-two");

    const res = await app.request("/api/admin/organizations/check-slugs", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slugs: ["org-one", "org-two", "org-three"] }),
    });
    t.equal(res.status, 200);
    const data = CheckSlugsResponse.assert(await res.json());
    t.equal(data.existing.length, 2);
    t.ok(data.existing.includes("org-one"));
    t.ok(data.existing.includes("org-two"));
    t.notOk(data.existing.includes("org-three"));
  });

  await t.test("returns empty array for no matches", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/organizations/check-slugs", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slugs: ["nonexistent-one", "nonexistent-two"] }),
    });
    t.equal(res.status, 200);
    const data = CheckSlugsResponse.assert(await res.json());
    t.equal(data.existing.length, 0);
  });

  await t.test("returns empty array for empty input", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/organizations/check-slugs", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slugs: [] }),
    });
    t.equal(res.status, 200);
    const data = CheckSlugsResponse.assert(await res.json());
    t.equal(data.existing.length, 0);
  });

  await t.test("requires admin authentication", async (t) => {
    const nonAdmin = await createUser("user@example.com", false);

    const res = await app.request("/api/admin/organizations/check-slugs", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${nonAdmin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slugs: ["test"] }),
    });
    t.equal(res.status, 403);
  });
});

await t.test("GET /api/admin/wallets", async (t) => {
  await t.test("returns list of wallets", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    await createWallet(org.id, "org-wallet");
    await createWallet(null, "master-wallet");

    const res = await app.request("/api/admin/wallets", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 2);
  });
});

await t.test("GET /api/admin/tenants", async (t) => {
  await t.test("returns list of tenants with nodes", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node.id, is_primary: true })
      .execute();

    const res = await app.request("/api/admin/tenants", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].name, "my-tenant");
    if (!data[0].nodes) throw new Error("expected data[0].nodes");
    t.equal(data[0].nodes.length, 1);
  });

  await t.test("returns tenants with tags", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    await db
      .insertInto("tenants")
      .values({
        name: "tagged-tenant",
        organization_id: org.id,
        backend_url: "http://backend.example.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "active",
        tags: ["production", "api"],
      })
      .execute();

    const res = await app.request("/api/admin/tenants", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].name, "tagged-tenant");
    t.same(data[0].tags, ["production", "api"]);
  });

  await t.test(
    "returns empty tags array for tenants without tags",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "no-tags-tenant");

      const res = await app.request("/api/admin/tenants", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 200);
      const data = AdminListItem.array().assert(await res.json());
      t.equal(data.length, 1);
      if (!data[0]) throw new Error("expected data[0]");
      t.same(data[0].tags, []);
    },
  );
});

await t.test("GET /api/admin/tenants/check-name", async (t) => {
  await t.test("returns available=true for unused name", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request(
      "/api/admin/tenants/check-name?name=new-tenant",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
    const data = AvailabilityResponse.assert(await res.json());
    t.equal(data.available, true);
  });

  await t.test("returns available=false for taken name", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    await createTenant(org.id, "taken-name");

    const res = await app.request(
      "/api/admin/tenants/check-name?name=taken-name",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
    const data = AvailabilityResponse.assert(await res.json());
    t.equal(data.available, false);
  });

  await t.test("excludes specified ID from check", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(
      `/api/admin/tenants/check-name?name=my-tenant&excludeId=${tenant.id}`,
      { headers: { Cookie: `auth_token=${admin.token}` } },
    );
    t.equal(res.status, 200);
    const data = AvailabilityResponse.assert(await res.json());
    t.equal(data.available, true);
  });

  await t.test("returns available=false for empty name", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/tenants/check-name?name=", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AvailabilityResponse.assert(await res.json());
    t.equal(data.available, false);
  });

  await t.test(
    "with organization_id: returns unavailable for name in same org",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "existing-api", { org_slug: "team" });

      const res = await app.request(
        `/api/admin/tenants/check-name?name=existing-api&organization_id=${org.id}`,
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, false);
    },
  );

  await t.test(
    "with organization_id: returns available for name in different org",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Org One", "org-one");
      const org2 = await createOrg("Org Two", "org-two");
      await createTenant(org1.id, "shared-api", { org_slug: "org-one" });

      const res = await app.request(
        `/api/admin/tenants/check-name?name=shared-api&organization_id=${org2.id}`,
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "with organization_id: returns available for name used by legacy tenant",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "legacy-api");

      const res = await app.request(
        `/api/admin/tenants/check-name?name=legacy-api&organization_id=${org.id}`,
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "legacy check: returns unavailable for name used by another legacy",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "legacy-svc");

      const res = await app.request(
        "/api/admin/tenants/check-name?name=legacy-svc",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, false);
    },
  );

  await t.test(
    "legacy check: returns available for name used by org_slug tenant",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "org-only-api", { org_slug: "team" });

      const res = await app.request(
        "/api/admin/tenants/check-name?name=org-only-api",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test("with org_slug=null: checks legacy namespace", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    await createTenant(org.id, "legacy-api");

    const res = await app.request(
      "/api/admin/tenants/check-name?name=legacy-api&org_slug=null",
      { headers: { Cookie: `auth_token=${admin.token}` } },
    );
    t.equal(res.status, 200);
    const data = AvailabilityResponse.assert(await res.json());
    t.equal(data.available, false);
  });

  await t.test(
    "with org_slug=null: returns available for name in org namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "org-api", { org_slug: "team" });

      const res = await app.request(
        "/api/admin/tenants/check-name?name=org-api&org_slug=null",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "with org_slug=<slug>: checks specific org namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "my-api", { org_slug: "team" });

      const res = await app.request(
        "/api/admin/tenants/check-name?name=my-api&org_slug=team",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, false);
    },
  );

  await t.test(
    "with org_slug=<slug>: returns available for name in legacy namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "legacy-only");

      const res = await app.request(
        "/api/admin/tenants/check-name?name=legacy-only&org_slug=team",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "with org_slug=<slug>: returns available for name in different org",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Org One", "org-one");
      await createOrg("Org Two", "org-two");
      await createTenant(org1.id, "shared-name", { org_slug: "org-one" });

      const res = await app.request(
        "/api/admin/tenants/check-name?name=shared-name&org_slug=org-two",
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "with org_slug and excludeId: excludes tenant from check",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-api", { org_slug: "team" });

      const res = await app.request(
        `/api/admin/tenants/check-name?name=my-api&org_slug=team&excludeId=${tenant.id}`,
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );

  await t.test(
    "with org_slug=null and excludeId: excludes tenant from check",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "legacy-api");

      const res = await app.request(
        `/api/admin/tenants/check-name?name=legacy-api&org_slug=null&excludeId=${tenant.id}`,
        { headers: { Cookie: `auth_token=${admin.token}` } },
      );
      t.equal(res.status, 200);
      const data = AvailabilityResponse.assert(await res.json());
      t.equal(data.available, true);
    },
  );
});

await t.test("POST /api/admin/tenants", async (t) => {
  await t.test("creates tenant with valid data", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "new-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
      }),
    });
    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "new-tenant");
    const tenant = await db
      .selectFrom("tenants")
      .select("default_scheme")
      .where("id", "=", data.id)
      .executeTakeFirstOrThrow();
    t.equal(tenant.default_scheme, "flex");
  });

  await t.test("persists root pricing rules on tenant creation", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const rules = [{ match: "$", capture: "10000" }];

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "flex-root-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        default_scheme: "flex",
        pricing_rules: rules,
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    const tenant = await db
      .selectFrom("tenants")
      .select("openapi_spec")
      .where("id", "=", data.id)
      .executeTakeFirstOrThrow();
    const spec = tenant.openapi_spec as Record<string, unknown>;
    const pricing = spec["x-faremeter-pricing"] as Record<string, unknown>;
    t.same(pricing.rules, rules);
  });

  await t.test("rejects invalid tenant name", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "!!!",
        backend_url: "http://backend.example.com",
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test("uses master wallet if no wallet_id provided", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const masterWallet = await createWallet(null, "master");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "auto-wallet-tenant",
        backend_url: "http://backend.example.com",
      }),
    });
    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.wallet_id, masterWallet.id);
  });

  await t.test(
    "creates registered tenant when register_only is true",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const node = await createNode("node-1");

      const res = await app.request("/api/admin/tenants", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "registered-tenant",
          backend_url: "http://backend.example.com",
          organization_id: org.id,
          node_ids: [node.id],
          register_only: true,
        }),
      });

      t.equal(res.status, 201);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.name, "registered-tenant");
      t.equal(data.status, "registered");
      t.equal(data.is_active, false);
    },
  );

  await t.test("creates tenant with tags", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "tagged-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        tags: ["production", "api", "v2"],
      }),
    });
    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "tagged-tenant");
    t.same(data.tags, ["production", "api", "v2"]);
  });

  await t.test("creates tenant with empty tags array", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "no-tags-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        tags: [],
      }),
    });
    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.same(data.tags, []);
  });

  await t.test(
    "creates tenant without tags field (defaults to empty)",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");

      const res = await app.request("/api/admin/tenants", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "default-tags-tenant",
          backend_url: "http://backend.example.com",
          organization_id: org.id,
        }),
      });
      t.equal(res.status, 201);
      const data = TenantResponse.assert(await res.json());
      t.same(data.tags, []);
    },
  );

  await t.test("rejects invalid tags (uppercase)", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "bad-tags-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        tags: ["Production"],
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects too many tags", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "many-tags-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        tags: ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"],
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects duplicate tags", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request("/api/admin/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "dupe-tags-tenant",
        backend_url: "http://backend.example.com",
        organization_id: org.id,
        tags: ["api", "production", "api"],
      }),
    });
    t.equal(res.status, 400);
  });
});

await t.test("POST /api/admin/tenants/:id/activate", async (t) => {
  await t.test("activates a registered tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const wallet = await createWallet(org.id, "Test Wallet");
    const node = await createNode("node-1");

    const tenant = await createTenant(org.id, "registered-tenant", {
      status: "registered",
      wallet_id: wallet.id,
      org_slug: "team",
    });

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        cert_status: null,
        is_primary: true,
      })
      .execute();

    const res = await app.request(`/api/admin/tenants/${tenant.id}/activate`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
      },
    });

    t.equal(res.status, 200);
    const data = ActivateResponse.assert(await res.json());
    t.equal(data.status, "pending");

    const updatedTenant = await db
      .selectFrom("tenants")
      .select(["status", "is_active"])
      .where("id", "=", tenant.id)
      .executeTakeFirstOrThrow();
    t.equal(updatedTenant.status, "pending");
    t.equal(updatedTenant.is_active, true);
  });

  await t.test("returns 400 if tenant is not registered", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "active-tenant", {
      status: "active",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}/activate`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
      },
    });

    t.equal(res.status, 400);
  });

  await t.test("returns 400 if no wallet assigned", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "no-wallet-tenant", {
      status: "registered",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}/activate`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
      },
    });

    t.equal(res.status, 400);
  });

  await t.test("returns 400 if wallet not funded", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const wallet = await db
      .insertInto("wallets")
      .values({
        name: "Unfunded Wallet",
        organization_id: org.id,
        wallet_config: JSON.stringify({
          solana: { "mainnet-beta": { address: "abc123" } },
        }),
        funding_status: "pending",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const tenant = await createTenant(org.id, "unfunded-wallet-tenant", {
      status: "registered",
      wallet_id: wallet.id,
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}/activate`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
      },
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.toLowerCase().includes("funded"));
  });

  await t.test("returns 400 if backend_url is empty", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const wallet = await db
      .insertInto("wallets")
      .values({
        name: "Funded Wallet",
        organization_id: org.id,
        wallet_config: JSON.stringify({
          solana: { "mainnet-beta": { address: "abc123" } },
        }),
        funding_status: "funded",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const tenant = await createTenant(org.id, "no-backend-tenant", {
      status: "registered",
      wallet_id: wallet.id,
      backend_url: "",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}/activate`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
      },
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.toLowerCase().includes("backend"));
  });
});

await t.test("PUT /api/admin/tenants/:id", async (t) => {
  await t.test("updates tenant backend_url", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend_url: "http://new-backend.example.com" }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.backend_url, "http://new-backend.example.com");
  });

  await t.test("returns 404 for non-existent tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/tenants/999", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend_url: "http://example.com" }),
    });
    t.equal(res.status, 404);
  });

  await t.test(
    "rejects modification during non-active/pending status",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant", {
        status: "deleting",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ backend_url: "http://example.com" }),
      });
      t.equal(res.status, 400);
    },
  );

  await t.test("rejects rename to taken name", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    await createTenant(org.id, "taken-name");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "taken-name" }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("already taken"));
  });

  await t.test("rejects rename when status is pending", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant", {
      status: "pending",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "new-name" }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("operation is in progress"));
  });

  await t.test("rejects rename when cert operation in progress", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        cert_status: "pending",
      })
      .execute();

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "new-name" }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("certificate operations"));
  });

  await t.test(
    "rejects org_slug change when cert operation in progress",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const node = await createNode("node-1");

      await db
        .insertInto("tenant_nodes")
        .values({
          tenant_id: tenant.id,
          node_id: node.id,
          cert_status: "deleting",
        })
        .execute();

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ org_slug: "new-slug" }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("certificate operations"));
    },
  );

  await t.test(
    "allows wallet_id assignment when status is pending",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const wallet = await createWallet(org.id, "my-wallet");
      const tenant = await createTenant(org.id, "my-tenant", {
        status: "pending",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ wallet_id: wallet.id }),
      });
      t.equal(res.status, 200);
    },
  );

  await t.test(
    "rejects non-wallet fields when status is pending",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant", {
        status: "pending",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ backend_url: "http://new.example.com" }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("Only wallet assignment"));
    },
  );

  await t.test("allows full edits when status is registered", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const wallet = await createWallet(org.id, "my-wallet");
    const tenant = await createTenant(org.id, "my-tenant", {
      status: "registered",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        backend_url: "http://new.example.com",
        wallet_id: wallet.id,
        default_price: 0.05,
      }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.backend_url, "http://new.example.com");
    t.equal(data.wallet_id, wallet.id);
  });

  await t.test(
    "switches from org mode to legacy mode with org_slug=null",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "my-tenant", org_slug: null }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "pending");

      const updated = await db
        .selectFrom("tenants")
        .select(["org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.org_slug, null);
    },
  );

  await t.test(
    "switches from legacy mode to org mode with org_slug",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "my-tenant", org_slug: "team" }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "pending");

      const updated = await db
        .selectFrom("tenants")
        .select(["org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.org_slug, "team");
    },
  );

  await t.test(
    "rejects switch to legacy if name collision in legacy namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "taken-name");
      const tenant = await createTenant(org.id, "taken-name", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "taken-name", org_slug: null }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("already taken"));
    },
  );

  await t.test(
    "rejects switch to org mode if name collision in org namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "taken-name", { org_slug: "team" });
      const tenant = await createTenant(org.id, "taken-name");

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "taken-name", org_slug: "team" }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("already taken"));
    },
  );

  await t.test(
    "allows same name when switching modes if available in target namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "unique-api", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "unique-api", org_slug: null }),
      });
      t.equal(res.status, 200);
    },
  );

  await t.test("changes name and org_slug simultaneously", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "old-name", {
      org_slug: "team",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "new-name", org_slug: null }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "new-name");
    t.equal(data.status, "pending");

    const updated = await db
      .selectFrom("tenants")
      .select(["name", "org_slug"])
      .where("id", "=", tenant.id)
      .executeTakeFirst();
    t.equal(updated?.org_slug, null);
  });

  await t.test("no-op when org_slug matches current value", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant", {
      org_slug: "team",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-tenant", org_slug: "team" }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.status, "active");
  });

  await t.test(
    "changes org_slug without name field (triggers rename for cert reprovisioning)",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ org_slug: null }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "pending");
      t.equal(data.name, "my-tenant");

      const updated = await db
        .selectFrom("tenants")
        .select(["org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.org_slug, null);
    },
  );

  await t.test("rejects org_slug change when status is pending", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant", {
      org_slug: "team",
      status: "pending",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: null }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("operation is in progress"));
  });

  await t.test(
    "org_slug-only change checks collision in target namespace",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      await createTenant(org.id, "collision-test");
      const tenant = await createTenant(org.id, "collision-test", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ org_slug: null }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("already taken"));
    },
  );

  await t.test("normalizes empty string org_slug to null", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant", {
      org_slug: "team",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: "" }),
    });
    t.equal(res.status, 200);

    const updated = await db
      .selectFrom("tenants")
      .select(["org_slug"])
      .where("id", "=", tenant.id)
      .executeTakeFirst();
    t.equal(updated?.org_slug, null);
  });

  await t.test(
    "changing organization_id auto-derives org_slug from new org",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Old Org", "old-org");
      const org2 = await createOrg("New Org", "new-org");
      const tenant = await createTenant(org1.id, "my-tenant", {
        org_slug: "old-org",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org2.id }),
      });
      t.equal(res.status, 200);

      const updated = await db
        .selectFrom("tenants")
        .select(["organization_id", "org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.organization_id, org2.id);
      t.equal(updated?.org_slug, "new-org");
    },
  );

  await t.test(
    "changing organization_id to null auto-sets org_slug to null",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant", {
        org_slug: "team",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: null }),
      });
      t.equal(res.status, 200);

      const updated = await db
        .selectFrom("tenants")
        .select(["organization_id", "org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.organization_id, null);
      t.equal(updated?.org_slug, null);
    },
  );

  await t.test(
    "explicit org_slug overrides auto-derived slug when changing org",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Old Org", "old-org");
      const org2 = await createOrg("New Org", "new-org");
      const tenant = await createTenant(org1.id, "my-tenant", {
        org_slug: "old-org",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org2.id, org_slug: null }),
      });
      t.equal(res.status, 200);

      const updated = await db
        .selectFrom("tenants")
        .select(["organization_id", "org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.organization_id, org2.id);
      t.equal(updated?.org_slug, null);
    },
  );

  await t.test(
    "legacy tenant (null org_slug) changing org_id derives org_slug and triggers rename",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Old Org", "old-org");
      const org2 = await createOrg("New Org", "new-org");
      // Tenant has org but NO org_slug (legacy mode)
      const tenant = await createTenant(org1.id, "my-tenant");

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org2.id }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "pending", "should trigger rename flow");

      const updated = await db
        .selectFrom("tenants")
        .select(["organization_id", "org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.organization_id, org2.id);
      t.equal(updated?.org_slug, "new-org");
    },
  );

  await t.test(
    "tenant with no org getting one assigned derives org_slug",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("New Org", "new-org");
      // Tenant has NO organization
      const tenant = await createTenant(null, "orphan-tenant");

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org.id }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "pending", "should trigger rename flow");

      const updated = await db
        .selectFrom("tenants")
        .select(["organization_id", "org_slug"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      t.equal(updated?.organization_id, org.id);
      t.equal(updated?.org_slug, "new-org");
    },
  );

  await t.test(
    "org_id change with derived slug collision is rejected",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Org One", "org-one");
      const org2 = await createOrg("Org Two", "org-two");
      // Existing tenant in org2's namespace
      await createTenant(org2.id, "my-api", { org_slug: "org-two" });
      // Legacy tenant we want to move
      const tenant = await createTenant(org1.id, "my-api");

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org2.id }),
      });
      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("already taken"));
    },
  );

  await t.test("rejects invalid org_slug format (uppercase)", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: "UPPERCASE" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects invalid org_slug format (spaces)", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: "invalid slug" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects org_slug that is too short", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: "ab" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects org_slug that is too long", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const longSlug = "a".repeat(60);

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_slug: longSlug }),
    });
    t.equal(res.status, 400);
  });

  await t.test(
    "org_id change verifies status is pending in response",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org1 = await createOrg("Old Org", "old-org");
      const org2 = await createOrg("New Org", "new-org");
      const tenant = await createTenant(org1.id, "my-tenant", {
        org_slug: "old-org",
      });

      const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization_id: org2.id }),
      });
      t.equal(res.status, 200);
      const data = TenantResponse.assert(await res.json());
      t.equal(
        data.status,
        "pending",
        "rename flow should set status to pending",
      );
      t.equal(data.name, "my-tenant");
    },
  );

  await t.test("updates tenant tags", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "tags-tenant",
        organization_id: org.id,
        backend_url: "http://backend.example.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "active",
        tags: ["old-tag"],
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["new-tag", "another-tag"] }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.same(data.tags, ["new-tag", "another-tag"]);
  });

  await t.test("clears tags with empty array", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "clear-tags-tenant",
        organization_id: org.id,
        backend_url: "http://backend.example.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "active",
        tags: ["tag1", "tag2"],
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: [] }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.same(data.tags, []);
  });

  await t.test("rejects invalid tags on update", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["INVALID"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("rejects too many tags on update", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["t1", "t2", "t3", "t4", "t5", "t6"] }),
    });
    t.equal(res.status, 400);
  });

  await t.test("can update tags along with other fields", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "combined-update");

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        backend_url: "http://new-backend.example.com",
        tags: ["production", "updated"],
      }),
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.backend_url, "http://new-backend.example.com");
    t.same(data.tags, ["production", "updated"]);
  });
});

await t.test("DELETE /api/admin/tenants/:id", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/tenants/999", {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("rejects if already deleting", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant", {
      status: "deleting",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("already being deleted"));
  });

  await t.test("rejects if cert operation in progress", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        cert_status: "pending",
      })
      .execute();

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("certificate operations"));
  });

  await t.test("deletes registered tenant immediately", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "registered-tenant", {
      status: "registered",
    });

    const res = await app.request(`/api/admin/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });

    t.equal(res.status, 200);

    const deletedTenant = await db
      .selectFrom("tenants")
      .select("id")
      .where("id", "=", tenant.id)
      .executeTakeFirst();
    t.equal(deletedTenant, undefined);
  });
});

await t.test("POST /api/admin/tenants/:id/nodes", async (t) => {
  await t.test("assigns node to tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    const res = await app.request(`/api/admin/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });
    t.equal(res.status, 201);
    const data = NodeAssignResponse.assert(await res.json());
    t.equal(data.success, true);
    t.equal(data.is_primary, true);
  });

  await t.test("returns 404 for non-existent tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const node = await createNode("node-1");

    const res = await app.request("/api/admin/tenants/999/nodes", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });
    t.equal(res.status, 404);
  });

  await t.test("returns 404 for non-existent node", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: 999 }),
    });
    t.equal(res.status, 404);
  });

  await t.test("rejects duplicate assignment", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node.id })
      .execute();

    const res = await app.request(`/api/admin/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("already assigned"));
  });

  await t.test("second node is not primary", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node1 = await createNode("node-1");
    const node2 = await createNode("node-2");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node1.id, is_primary: true })
      .execute();

    const res = await app.request(`/api/admin/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node2.id }),
    });
    t.equal(res.status, 201);
    const data = NodeAssignResponse.assert(await res.json());
    t.equal(data.is_primary, false);
  });
});

await t.test("DELETE /api/admin/tenants/:id/nodes/:nodeId", async (t) => {
  await t.test("returns 404 if node not assigned", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}/nodes/999`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("rejects removal when cert operation in progress", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        cert_status: "pending",
      })
      .execute();

    const res = await app.request(
      `/api/admin/tenants/${tenant.id}/nodes/${node.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("operation is in progress"));
  });

  await t.test("removes assigned node successfully", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("node-1");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node.id, cert_status: "active" })
      .execute();

    const res = await app.request(
      `/api/admin/tenants/${tenant.id}/nodes/${node.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
    const data = NodeAssignResponse.assert(await res.json());
    t.equal(data.success, true);
  });
});

await t.test("GET /api/admin/tenants/:tenantId/endpoints", async (t) => {
  await t.test("returns endpoints for tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    await createEndpoint(tenant.id, "/api/v1");
    await createEndpoint(tenant.id, "/api/v2");

    const res = await app.request(`/api/admin/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 2);
  });

  await t.test("returns 404 for non-existent tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/tenants/999/endpoints", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test(
  "PUT /api/admin/tenants/:tenantId/endpoints/:endpointId",
  async (t) => {
    await t.test("updates endpoint", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/api/v1");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ price: 0.05 }),
        },
      );
      t.equal(res.status, 200);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.price, 0.05);
    });

    await t.test("persists endpoint pricing rules", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/v1/items");

      await db
        .updateTable("tenants")
        .set({
          openapi_spec: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "API", version: "1.0.0" },
            paths: {
              "/v1/items": {
                post: { summary: "Items" },
              },
            },
          }),
        })
        .where("id", "=", tenant.id)
        .execute();

      await db
        .updateTable("endpoints")
        .set({
          openapi_source_paths: ["/v1/items"],
          http_method: "POST",
        })
        .where("id", "=", endpoint.id)
        .execute();

      const rules = [
        {
          match: "$",
          authorize: "1000000",
          capture: "$.response.body.data.length * 10000",
        },
      ];

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scheme: "flex",
            pricing_rules: rules,
          }),
        },
      );

      t.equal(res.status, 200);

      const updated = await db
        .selectFrom("tenants")
        .select("openapi_spec")
        .where("id", "=", tenant.id)
        .executeTakeFirstOrThrow();
      const spec = updated.openapi_spec as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      const pricing = spec.paths["/v1/items"]?.post?.["x-faremeter-pricing"] as
        | Record<string, unknown>
        | undefined;
      t.same(pricing?.rules, rules);
    });

    await t.test("returns 404 for non-existent endpoint", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/999`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ price: 0.05 }),
        },
      );
      t.equal(res.status, 404);
    });

    await t.test("handles regex path pattern", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/api/v1");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: "^/api/v[0-9]+/.*$" }),
        },
      );
      t.equal(res.status, 200);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.path, "^/api/v[0-9]+/.*$");
      t.equal(data.path_pattern, "^/api/v[0-9]+/.*$");
    });

    await t.test("handles path with {param} placeholders", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/api/v1");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: "/users/{userId}/posts/{postId}" }),
        },
      );
      t.equal(res.status, 200);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.path, "/users/{userId}/posts/{postId}");
      t.equal(data.path_pattern, "^/users/[^/]+/posts/[^/]+$");
    });
  },
);

await t.test("GET /api/admin/transactions", async (t) => {
  await t.test("returns paginated transactions", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("transactions")
      .values({
        tenant_id: tenant.id,
        amount: 0.05,
        ngx_request_id: "req-1",
        request_path: "/test",
      })
      .execute();

    const res = await app.request("/api/admin/transactions?limit=10&offset=0", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = TransactionsResponse.assert(await res.json());
    t.equal(data.transactions.length, 1);
    t.equal(data.total, 1);
    t.equal(data.limit, 10);
    t.equal(data.offset, 0);
  });
});

await t.test("GET /api/admin/nodes", async (t) => {
  await t.test("returns list of nodes with tenant counts", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const node = await createNode("node-1");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node.id })
      .execute();

    const res = await app.request("/api/admin/nodes", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].tenant_count, 1);
  });
});

await t.test("GET /api/admin/nodes/:id/tenants", async (t) => {
  await t.test("returns tenants for node", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const node = await createNode("node-1");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenant.id, node_id: node.id, is_primary: true })
      .execute();

    const res = await app.request(`/api/admin/nodes/${node.id}/tenants`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].name, "my-tenant");
    t.equal(data[0].is_primary, true);
  });
});

await t.test("GET /api/admin/nodes/:id/health", async (t) => {
  await t.test("returns dev response in test mode", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const node = await createNode("node-1");

    const res = await app.request(`/api/admin/nodes/${node.id}/health`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = HealthResponse.assert(await res.json());
    t.equal(data.healthy, true);
    t.equal(data.dev, true);
  });
});

await t.test("GET /api/admin/stats", async (t) => {
  await t.test("returns platform stats", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createUser("user@example.com");
    const org = await createOrg("Team", "team");
    await createTenant(org.id, "my-tenant");
    await createNode("node-1");

    const res = await app.request("/api/admin/stats", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = PlatformStatsResponse.assert(await res.json());
    t.equal(data.users, 2);
    t.equal(data.organizations, 1);
    t.equal(data.tenants, 1);
    t.equal(data.nodes, 1);
    t.equal(data.transactions, 0);
  });
});

await t.test("GET /api/admin/settings", async (t) => {
  await t.test("returns 404 if no settings", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/settings", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns settings", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = MinBalanceResponse.assert(await res.json());
    t.equal(data.minimumBalanceSol, 0.1);
    t.equal(data.minimumBalanceUsdc, 10);
    t.equal(data.hasWallet, false);
  });
});

await t.test("PUT /api/admin/settings", async (t) => {
  await t.test("updates settings", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ minimum_balance_sol: 0.5 }),
    });
    t.equal(res.status, 200);
    const data = MinBalanceResponse.assert(await res.json());
    t.equal(data.minimumBalanceSol, 0.5);
  });

  await t.test("returns 404 if no settings row exists", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/settings", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ minimum_balance_sol: 0.5 }),
    });
    t.equal(res.status, 404);
  });
});

await t.test("GET /api/admin/waitlist", async (t) => {
  await t.test("returns waitlist entries", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await addToWaitlist("user1@example.com");
    await addToWaitlist("user2@example.com");

    const res = await app.request("/api/admin/waitlist", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 2);
  });
});

await t.test("DELETE /api/admin/waitlist/:id", async (t) => {
  await t.test("deletes waitlist entry", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const entry = await addToWaitlist("user@example.com");

    const res = await app.request(`/api/admin/waitlist/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);
  });

  await t.test("returns 404 for non-existent entry", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/waitlist/999", {
      method: "DELETE",
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("PATCH /api/admin/waitlist/:id", async (t) => {
  await t.test("whitelists a user", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const entry = await addToWaitlist("user@example.com");

    const res = await app.request(`/api/admin/waitlist/${entry.id}`, {
      method: "PATCH",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ whitelisted: true }),
    });
    t.equal(res.status, 200);
    const data = WhitelistResponse.assert(await res.json());
    t.ok(data.whitelisted);
  });

  await t.test("un-whitelists a user who has not signed up", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const entry = await addToWaitlist("user@example.com", {
      whitelisted: true,
    });

    const res = await app.request(`/api/admin/waitlist/${entry.id}`, {
      method: "PATCH",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ whitelisted: false }),
    });
    t.equal(res.status, 200);
    const data = WhitelistResponse.assert(await res.json());
    t.notOk(data.whitelisted);
  });

  await t.test("cannot un-whitelist a user who has signed up", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const entry = await addToWaitlist("user@example.com", {
      whitelisted: true,
      signed_up: true,
    });

    const res = await app.request(`/api/admin/waitlist/${entry.id}`, {
      method: "PATCH",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ whitelisted: false }),
    });
    t.equal(res.status, 400);
  });

  await t.test("returns 404 for non-existent entry", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/waitlist/999", {
      method: "PATCH",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ whitelisted: true }),
    });
    t.equal(res.status, 404);
  });
});

await t.test("GET /api/admin/cert-status", async (t) => {
  await t.test("returns cert statuses", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const node = await createNode("node-1");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        is_primary: true,
        cert_status: "active",
      })
      .execute();

    const res = await app.request("/api/admin/cert-status", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = CertStatusItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].cert_status, "active");
  });
});

await t.test("GET /api/admin/tenants-with-wallets", async (t) => {
  await t.test("returns only tenants with wallets", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const wallet = await createWallet(org.id, "org-wallet");
    await createTenant(org.id, "with-wallet", { wallet_id: wallet.id });
    await createTenant(org.id, "no-wallet");

    const res = await app.request("/api/admin/tenants-with-wallets", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = AdminListItem.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].name, "with-wallet");
  });
});

await t.test("empty results", async (t) => {
  await t.test("GET /api/admin/users returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/users", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 1);
  });

  await t.test("GET /api/admin/organizations returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/organizations", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 0);
  });

  await t.test("GET /api/admin/wallets returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/wallets", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 0);
  });

  await t.test("GET /api/admin/tenants returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/tenants", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 0);
  });

  await t.test("GET /api/admin/nodes returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/nodes", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 0);
  });

  await t.test("GET /api/admin/waitlist returns empty list", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/waitlist", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = (await res.json()) as unknown[];
    t.equal(data.length, 0);
  });

  await t.test(
    "GET /api/admin/transactions returns empty with total 0",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/transactions", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 200);
      const data = TransactionsResponse.assert(await res.json());
      t.equal(data.transactions.length, 0);
      t.equal(data.total, 0);
    },
  );
});

await t.test("handles invalid/NaN IDs gracefully", async (t) => {
  await t.test(
    "GET /api/admin/users/:id with invalid ID returns 404",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/users/invalid", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "GET /api/admin/organizations/:id with invalid ID returns 404",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/organizations/invalid", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "DELETE /api/admin/users/:id with invalid ID returns 404",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/users/invalid", {
        method: "DELETE",
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "GET /api/admin/tenants/:tenantId/endpoints with invalid ID returns 404",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request("/api/admin/tenants/invalid/endpoints", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 404);
    },
  );
});

await t.test("GET /api/admin/analytics", async (t) => {
  await t.test("returns platform analytics", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("transactions")
      .values({
        tenant_id: tenant.id,
        amount: 0.05,
        ngx_request_id: "req-1",
        request_path: "/test",
      })
      .execute();

    const res = await app.request("/api/admin/analytics", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
  });
});

await t.test("GET /api/admin/tenants/:id/faremeter-transactions", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/tenants/999/faremeter-transactions",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 404);
  });

  await t.test(
    "returns empty transactions when no faremeter account",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "unknown-tenant");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/faremeter-transactions`,
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 200);
      const data = TransactionsResponse.assert(await res.json());
      t.equal(data.transactions.length, 0);
      t.equal(data.error, "No Faremeter account");
    },
  );

  await t.test(
    "returns transactions for tenant with faremeter account",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "elon");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/faremeter-transactions`,
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 200);
      const data = TransactionsResponse.assert(await res.json());
      t.ok(Array.isArray(data.transactions));
      t.ok(data.transactions.length > 0);
    },
  );

  await t.test("supports pagination parameters", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "elon");

    const res = await app.request(
      `/api/admin/tenants/${tenant.id}/faremeter-transactions?limit=5&offset=0`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
    const data = TransactionsResponse.assert(await res.json());
    t.equal(data.limit, 5);
    t.equal(data.offset, 0);
  });

  await t.test("supports force refresh", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "elon");

    const res = await app.request(
      `/api/admin/tenants/${tenant.id}/faremeter-transactions?refresh=true`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });
});

await t.test("GET /api/admin/settings/balances", async (t) => {
  await t.test("returns 404 when no wallet configured", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings/balances", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns 404 when admin_settings not initialized", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/settings/balances", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("GET /api/admin/organizations/:id/analytics", async (t) => {
  await t.test("returns 400 for invalid organization ID", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/organizations/invalid/analytics",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("returns analytics for valid organization", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request(
      `/api/admin/organizations/${org.id}/analytics`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });
});

await t.test("GET /api/admin/tenants/:id/analytics", async (t) => {
  await t.test("returns 400 for invalid tenant ID", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/tenants/invalid/analytics", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 400);
  });

  await t.test("returns analytics for valid tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/admin/tenants/${tenant.id}/analytics`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
  });
});

await t.test(
  "GET /api/admin/tenants/:tenantId/endpoints/:endpointId/analytics",
  async (t) => {
    await t.test("returns 400 for invalid endpoint ID", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request(
        "/api/admin/tenants/1/endpoints/invalid/analytics",
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 400);
    });

    await t.test("returns analytics for valid endpoint", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/api/v1");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/endpoints/${endpoint.id}/analytics`,
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 200);
    });
  },
);

await t.test(
  "GET /api/admin/tenants/:tenantId/catch-all/analytics",
  async (t) => {
    await t.test("returns 400 for invalid tenant ID", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const res = await app.request(
        "/api/admin/tenants/invalid/catch-all/analytics",
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 400);
    });

    await t.test("returns analytics for valid tenant", async (t) => {
      const admin = await createUser("admin@example.com", true);
      const org = await createOrg("Team", "team");
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/admin/tenants/${tenant.id}/catch-all/analytics`,
        {
          headers: { Cookie: `auth_token=${admin.token}` },
        },
      );
      t.equal(res.status, 200);
    });
  },
);

await t.test("GET /api/admin/analytics/earnings", async (t) => {
  await t.test("returns 400 for missing level", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request("/api/admin/analytics/earnings?id=1", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("level"));
  });

  await t.test("returns 400 for invalid level", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=invalid&id=1",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("returns 400 for missing ID", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=tenant",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("ID"));
  });

  await t.test("returns 400 for invalid ID", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=tenant&id=invalid",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("returns 400 for invalid granularity", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=tenant&id=1&granularity=invalid",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("granularity"));
  });

  await t.test("returns 400 for invalid periods", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=tenant&id=1&periods=0",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("returns 400 for periods > 365", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const res = await app.request(
      "/api/admin/analytics/earnings?level=tenant&id=1&periods=500",
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 400);
  });

  await t.test("accepts valid organization level request", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");

    const res = await app.request(
      `/api/admin/analytics/earnings?level=organization&id=${org.id}&granularity=month&periods=6`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });

  await t.test("accepts valid tenant level request", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(
      `/api/admin/analytics/earnings?level=tenant&id=${tenant.id}&granularity=day&periods=30`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });

  await t.test("accepts valid endpoint level request", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");
    const endpoint = await createEndpoint(tenant.id, "/api/v1");

    const res = await app.request(
      `/api/admin/analytics/earnings?level=endpoint&id=${endpoint.id}&granularity=week&periods=12`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });

  await t.test("uses default granularity and periods", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(
      `/api/admin/analytics/earnings?level=tenant&id=${tenant.id}`,
      {
        headers: { Cookie: `auth_token=${admin.token}` },
      },
    );
    t.equal(res.status, 200);
  });
});

await t.test("GET /api/admin/settings/email", async (t) => {
  await t.test("returns 404 if no settings row exists", async (t) => {
    const admin = await createUser("admin@example.com", true);

    const res = await app.request("/api/admin/settings/email", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns unconfigured state when no email_config", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings/email", {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = EmailConfigResponse.assert(await res.json());
    t.equal(data.configured, false);
    t.equal(data.from_email, null);
    t.equal(data.site_url, null);
    t.equal(data.template_ids, null);
  });

  await t.test(
    "returns configured state when email_config exists",
    async (t) => {
      const admin = await createUser("admin@example.com", true);
      await createAdminSettings();
      await db
        .updateTable("admin_settings")
        .set({
          email_config: JSON.stringify({
            from_email: "noreply@test.com",
            site_url: "https://test.com",
            template_ids: {
              verification: 123,
              welcome: 456,
              invitation: 789,
              password_reset: 101,
            },
          }),
        })
        .where("id", "=", 1)
        .execute();

      const res = await app.request("/api/admin/settings/email", {
        headers: { Cookie: `auth_token=${admin.token}` },
      });
      t.equal(res.status, 200);
      const data = EmailConfigResponse.assert(await res.json());
      t.equal(data.from_email, "noreply@test.com");
      t.equal(data.site_url, "https://test.com");
      if (!data.template_ids) throw new Error("expected template_ids");
      t.equal(data.template_ids.verification, 123);
      t.equal(data.template_ids.welcome, 456);
      t.equal(data.template_ids.invitation, 789);
      t.equal(data.template_ids.password_reset, 101);
    },
  );

  await t.test("requires admin", async (t) => {
    const user = await createUser("user@example.com", false);

    const res = await app.request("/api/admin/settings/email", {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 403);
  });
});

await t.test("PUT /api/admin/settings/email", async (t) => {
  await t.test("creates email config", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings/email", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_email: "noreply@example.com",
        site_url: "https://example.com",
        template_ids: {
          verification: 100,
          welcome: 200,
        },
      }),
    });
    t.equal(res.status, 200);
    const data = EmailConfigResponse.assert(await res.json());
    t.equal(data.from_email, "noreply@example.com");
    t.equal(data.site_url, "https://example.com");
    if (!data.template_ids) throw new Error("expected template_ids");
    t.equal(data.template_ids.verification, 100);
    t.equal(data.template_ids.welcome, 200);
    t.equal(data.template_ids.invitation, 0);
    t.equal(data.template_ids.password_reset, 0);
  });

  await t.test("merges partial updates", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();
    await db
      .updateTable("admin_settings")
      .set({
        email_config: JSON.stringify({
          from_email: "old@test.com",
          site_url: "https://old.com",
          template_ids: {
            verification: 1,
            welcome: 2,
            invitation: 3,
            password_reset: 4,
          },
        }),
      })
      .where("id", "=", 1)
      .execute();

    const res = await app.request("/api/admin/settings/email", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_email: "new@test.com",
        template_ids: { verification: 999 },
      }),
    });
    t.equal(res.status, 200);
    const data = EmailConfigResponse.assert(await res.json());
    t.equal(data.from_email, "new@test.com");
    t.ok(data.site_url); // Preserved from previous config
    if (!data.template_ids) throw new Error("expected template_ids");
    t.equal(data.template_ids.verification, 999);
  });

  await t.test("validates email format", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings/email", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from_email: "not-an-email" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("validates URL format", async (t) => {
    const admin = await createUser("admin@example.com", true);
    await createAdminSettings();

    const res = await app.request("/api/admin/settings/email", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ site_url: "not-a-url" }),
    });
    t.equal(res.status, 400);
  });

  await t.test("requires admin", async (t) => {
    const user = await createUser("user@example.com", false);

    const res = await app.request("/api/admin/settings/email", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from_email: "test@test.com" }),
    });
    t.equal(res.status, 403);
  });
});
