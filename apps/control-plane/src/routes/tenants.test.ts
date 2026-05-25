import "../tests/setup/env.js";
import t from "tap";
import { type } from "arktype";
import { Hono } from "hono";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { signToken } from "../middleware/auth.js";
import { tenantsRoutes } from "./tenants.js";

const TenantResponse = type({
  "id?": "number",
  "name?": "string",
  "backend_url?": "string",
  "default_price?": "number",
  "default_scheme?": "string",
  "status?": "string",
  "is_active?": "boolean",
  "upstream_auth_header?": "string | null",
  "+": "delete",
});

const ErrorResponse = type({
  error: "string",
  "+": "delete",
});

const DeleteResponse = type({
  deleted: "boolean",
  "+": "delete",
});

const NodeAssignment = type({
  "node_name?": "string",
  "is_primary?": "boolean",
  "tenant_id?": "number",
  "node_id?": "number",
  "+": "delete",
});

const app = new Hono();
app.route("/api/tenants", tenantsRoutes);

await setupTestSchema();

async function createAdminUser() {
  const user = await db
    .insertInto("users")
    .values({
      email: "admin@example.com",
      password_hash: "hash",
      is_admin: true,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  return signToken({ userId: user.id, email: user.email, isAdmin: true });
}

async function createNonAdminUser() {
  const user = await db
    .insertInto("users")
    .values({
      email: "user@example.com",
      password_hash: "hash",
      is_admin: false,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  return signToken({ userId: user.id, email: user.email, isAdmin: false });
}

async function createOrgMemberWithTenant(role: string) {
  const org = await db
    .insertInto("organizations")
    .values({ name: "test-org", slug: "test-org" })
    .returning("id")
    .executeTakeFirstOrThrow();

  const user = await db
    .insertInto("users")
    .values({
      email: `${role}@example.com`,
      password_hash: "hash",
      is_admin: false,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  await db
    .insertInto("user_organizations")
    .values({ user_id: user.id, organization_id: org.id, role })
    .execute();

  const tenant = await db
    .insertInto("tenants")
    .values({
      name: "org-tenant",
      backend_url: "http://backend.com",
      default_price: 0.01,
      default_scheme: "exact",
      organization_id: org.id,
      org_slug: "test-org",
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const token = signToken({
    userId: user.id,
    email: user.email,
    isAdmin: false,
  });

  return { token, tenantId: tenant.id };
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("GET /api/tenants", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/tenants");
    t.equal(res.status, 401);
  });

  await t.test("returns 403 for non-admin", async (t) => {
    const token = await createNonAdminUser();
    const res = await app.request("/api/tenants", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 403);
  });

  await t.test("returns empty list for admin", async (t) => {
    const token = await createAdminUser();
    const res = await app.request("/api/tenants", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
    const data = TenantResponse.array().assert(await res.json());
    t.same(data, []);
  });

  await t.test("returns tenants list", async (t) => {
    const token = await createAdminUser();

    await db
      .insertInto("tenants")
      .values({
        name: "tenant1",
        backend_url: "http://backend1.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .execute();

    await db
      .insertInto("tenants")
      .values({
        name: "tenant2",
        backend_url: "http://backend2.com",
        default_price: 0.02,
        default_scheme: "prefix",
      })
      .execute();

    const res = await app.request("/api/tenants", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
    const data = TenantResponse.array().assert(await res.json());
    t.equal(data.length, 2);
  });
});

await t.test("GET /api/tenants/:id", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();
    const res = await app.request("/api/tenants/999", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns tenant details", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "my-tenant",
        backend_url: "http://backend.com",
        default_price: 0.05,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "my-tenant");
    t.equal(data.backend_url, "http://backend.com");
  });
});

await t.test("POST /api/tenants", async (t) => {
  await t.test("creates tenant with minimal data", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "new-tenant",
        backend_url: "http://new-backend.com",
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "new-tenant");
    t.equal(data.backend_url, "http://new-backend.com");
    t.equal(data.default_price, 0);
    t.equal(data.default_scheme, "flex");
  });

  await t.test("creates tenant with all fields", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "full-tenant",
        backend_url: "http://full-backend.com",
        default_price: 0.1,
        default_scheme: "exact",
        upstream_auth_header: "X-API-Key",
        upstream_auth_value: "secret123",
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.default_price, 0.1);
    t.equal(data.default_scheme, "exact");
    t.equal(data.upstream_auth_header, "X-API-Key");
  });

  await t.test("sanitizes tenant name", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "My Tenant Name!",
        backend_url: "http://backend.com",
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "my-tenant-name");
  });

  await t.test("rejects empty name", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "",
        backend_url: "http://backend.com",
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects backend_url with leading whitespace", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ws-tenant",
        backend_url: " https://api.example.com",
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects backend_url with trailing whitespace", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ws-tenant",
        backend_url: "https://api.example.com ",
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects invalid backend_url", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "bad-url-tenant",
        backend_url: "not-a-url",
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects non-http backend_url", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ftp-tenant",
        backend_url: "ftp://files.example.com",
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("accepts valid https backend_url with path", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "path-tenant",
        backend_url: "https://api.openai.com/v1/responses",
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.backend_url, "https://api.openai.com/v1/responses");
  });

  await t.test("creates tenant with status active by default", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "active-tenant",
        backend_url: "http://backend.com",
      }),
    });

    t.equal(res.status, 201);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.status, "active");
  });

  await t.test(
    "creates tenant with status registered when register_only is true",
    async (t) => {
      const token = await createAdminUser();

      const res = await app.request("/api/tenants", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "registered-tenant",
          backend_url: "http://backend.com",
          register_only: true,
        }),
      });

      t.equal(res.status, 201);
      const data = TenantResponse.assert(await res.json());
      t.equal(data.status, "registered");
      t.equal(data.is_active, false);
    },
  );
});

await t.test("PUT /api/tenants/:id", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants/999", {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "updated" }),
    });

    t.equal(res.status, 404);
  });

  await t.test("updates tenant fields", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "old-name",
        backend_url: "http://old.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "new-name",
        backend_url: "http://new.com",
        default_price: 0.05,
      }),
    });

    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.name, "new-name");
    t.equal(data.backend_url, "http://new.com");
    t.equal(data.default_price, 0.05);
  });

  await t.test("rejects update when status is not active", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "pending-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "pending",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "updated" }),
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("operation is in progress"));
  });

  await t.test("allows update when status is registered", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "registered-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "registered",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend_url: "http://new-backend.com" }),
    });

    t.equal(res.status, 200);
    const data = TenantResponse.assert(await res.json());
    t.equal(data.backend_url, "http://new-backend.com");
  });
});

await t.test("tenant root pricing rules", async (t) => {
  await t.test(
    "member can update tenant-level Flex pricing rules",
    async (t) => {
      const { token, tenantId } = await createOrgMemberWithTenant("member");
      const rules = [{ match: "$", capture: "10000" }];

      const res = await app.request(`/api/tenants/${tenantId}/pricing-rules`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rules }),
      });

      t.equal(res.status, 200);

      const tenant = await db
        .selectFrom("tenants")
        .select("openapi_spec")
        .where("id", "=", tenantId)
        .executeTakeFirstOrThrow();
      const spec = tenant.openapi_spec as Record<string, unknown>;
      const pricing = spec["x-faremeter-pricing"] as Record<string, unknown>;
      t.same(pricing.rules, rules);
    },
  );

  await t.test("reads tenant-level pricing rules", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");
    const rules = [{ match: "$", capture: "20000" }];

    await db
      .updateTable("tenants")
      .set({
        openapi_spec: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "API", version: "1.0.0" },
          "x-faremeter-pricing": { rules },
          paths: {},
        }),
      })
      .where("id", "=", tenantId)
      .execute();

    const res = await app.request(`/api/tenants/${tenantId}/pricing-rules`, {
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);
    const data = (await res.json()) as { rules: unknown[]; editable: boolean };
    t.equal(data.editable, true);
    t.same(data.rules, rules);
  });
});

await t.test("DELETE /api/tenants/:id", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants/999", {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 404);
  });

  await t.test("deletes tenant", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "to-delete",
        backend_url: "http://delete.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);

    const check = await db
      .selectFrom("tenants")
      .select("id")
      .where("id", "=", tenant.id)
      .executeTakeFirst();
    t.equal(check, undefined);
  });

  await t.test("deletes associated transactions", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "tenant-with-txns",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("transactions")
      .values([
        {
          tenant_id: tenant.id,
          amount: 0.01,
          ngx_request_id: "req-1",
          request_path: "/test",
        },
        {
          tenant_id: tenant.id,
          amount: 0.02,
          ngx_request_id: "req-2",
          request_path: "/test2",
        },
      ])
      .execute();

    const txnsBefore = await db
      .selectFrom("transactions")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(txnsBefore.length, 2);

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);

    const txnsAfter = await db
      .selectFrom("transactions")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(txnsAfter.length, 0);
  });

  await t.test("deletes associated endpoints", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "tenant-with-endpoints",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("endpoints")
      .values([
        {
          tenant_id: tenant.id,
          path_pattern: "/api/v1/*",
          price: 0.01,
        },
        {
          tenant_id: tenant.id,
          path_pattern: "/api/v2/*",
          price: 0.02,
        },
      ])
      .execute();

    const endpointsBefore = await db
      .selectFrom("endpoints")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(endpointsBefore.length, 2);

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);

    const endpointsAfter = await db
      .selectFrom("endpoints")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(endpointsAfter.length, 0);
  });

  await t.test("does not affect other tenants data", async (t) => {
    const token = await createAdminUser();

    const tenant1 = await db
      .insertInto("tenants")
      .values({
        name: "tenant-to-delete",
        backend_url: "http://backend1.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const tenant2 = await db
      .insertInto("tenants")
      .values({
        name: "tenant-to-keep",
        backend_url: "http://backend2.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("transactions")
      .values([
        {
          tenant_id: tenant1.id,
          amount: 0.01,
          ngx_request_id: "req-delete",
          request_path: "/delete",
        },
        {
          tenant_id: tenant2.id,
          amount: 0.02,
          ngx_request_id: "req-keep",
          request_path: "/keep",
        },
      ])
      .execute();

    await db
      .insertInto("endpoints")
      .values([
        {
          tenant_id: tenant1.id,
          path_pattern: "/delete/*",
          price: 0.01,
        },
        {
          tenant_id: tenant2.id,
          path_pattern: "/keep/*",
          price: 0.02,
        },
      ])
      .execute();

    const res = await app.request(`/api/tenants/${tenant1.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);

    const tenant2Txns = await db
      .selectFrom("transactions")
      .select("id")
      .where("tenant_id", "=", tenant2.id)
      .execute();
    t.equal(tenant2Txns.length, 1, "other tenant transactions preserved");

    const tenant2Endpoints = await db
      .selectFrom("endpoints")
      .select("id")
      .where("tenant_id", "=", tenant2.id)
      .execute();
    t.equal(tenant2Endpoints.length, 1, "other tenant endpoints preserved");

    const tenant2Check = await db
      .selectFrom("tenants")
      .select("id")
      .where("id", "=", tenant2.id)
      .executeTakeFirst();
    t.ok(tenant2Check, "other tenant still exists");
  });

  await t.test("handles tenant with no associated data", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "empty-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);
  });

  await t.test("deletes all data with many records", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "tenant-many-records",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const txnValues = Array.from({ length: 50 }, (_, i) => ({
      tenant_id: tenant.id,
      amount: 0.01,
      ngx_request_id: `req-${i}`,
      request_path: `/path-${i}`,
    }));
    await db.insertInto("transactions").values(txnValues).execute();

    const endpointValues = Array.from({ length: 20 }, (_, i) => ({
      tenant_id: tenant.id,
      path_pattern: `/api/v${i}/*`,
      price: 0.01,
    }));
    await db.insertInto("endpoints").values(endpointValues).execute();

    const res = await app.request(`/api/tenants/${tenant.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);

    const txnsAfter = await db
      .selectFrom("transactions")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(txnsAfter.length, 0, "all 50 transactions deleted");

    const endpointsAfter = await db
      .selectFrom("endpoints")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(endpointsAfter.length, 0, "all 20 endpoints deleted");
  });
});

await t.test("GET /api/tenants/:id/nodes", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants/999/nodes", {
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 404);
  });

  await t.test("returns empty list when no nodes assigned", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "no-nodes",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);
    const data = NodeAssignment.array().assert(await res.json());
    t.same(data, []);
  });

  await t.test("returns assigned nodes", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "has-nodes",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "node1",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        is_primary: true,
      })
      .execute();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 200);
    const data = NodeAssignment.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].node_name, "node1");
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].is_primary, true);
  });
});

await t.test("POST /api/tenants/:id/nodes", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "node1",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request("/api/tenants/999/nodes", {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });

    t.equal(res.status, 404);
    const data = ErrorResponse.assert(await res.json());
    t.equal(data.error, "Tenant not found");
  });

  await t.test("returns 404 for non-existent node", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: 9999 }),
    });

    t.equal(res.status, 404);
    const data = ErrorResponse.assert(await res.json());
    t.equal(data.error, "Node not found");
  });

  await t.test("rejects node without public IP", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "no-public-ip-node",
        internal_ip: "10.0.0.1",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("public IP"));
  });

  await t.test("rejects already assigned node", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "already-assigned-node",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        is_primary: true,
      })
      .execute();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });

    t.equal(res.status, 409);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("already assigned"));
  });

  await t.test(
    "creates node assignment with is_primary false by default",
    async (t) => {
      const token = await createAdminUser();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "test-tenant",
          backend_url: "http://backend.com",
          default_price: 0.01,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const node = await db
        .insertInto("nodes")
        .values({
          name: "new-node",
          internal_ip: "10.0.0.1",
          public_ip: "1.2.3.4",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ node_id: node.id }),
      });

      t.equal(res.status, 201);
      const data = NodeAssignment.assert(await res.json());
      t.equal(data.tenant_id, tenant.id);
      t.equal(data.node_id, node.id);
      t.equal(data.is_primary, false);
    },
  );

  await t.test("creates node assignment with is_primary true", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "test-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "primary-node",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id, is_primary: true }),
    });

    t.equal(res.status, 201);
    const data = NodeAssignment.assert(await res.json());
    t.equal(data.is_primary, true);
  });

  await t.test(
    "clears existing primary when assigning new primary",
    async (t) => {
      const token = await createAdminUser();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "test-tenant",
          backend_url: "http://backend.com",
          default_price: 0.01,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const node1 = await db
        .insertInto("nodes")
        .values({
          name: "node1",
          internal_ip: "10.0.0.1",
          public_ip: "1.2.3.4",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const node2 = await db
        .insertInto("nodes")
        .values({
          name: "node2",
          internal_ip: "10.0.0.2",
          public_ip: "2.3.4.5",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("tenant_nodes")
        .values({
          tenant_id: tenant.id,
          node_id: node1.id,
          is_primary: true,
        })
        .execute();

      const res = await app.request(`/api/tenants/${tenant.id}/nodes`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ node_id: node2.id, is_primary: true }),
      });

      t.equal(res.status, 201);

      const oldPrimary = await db
        .selectFrom("tenant_nodes")
        .select("is_primary")
        .where("tenant_id", "=", tenant.id)
        .where("node_id", "=", node1.id)
        .executeTakeFirst();

      t.equal(oldPrimary?.is_primary, false);

      const newPrimary = await db
        .selectFrom("tenant_nodes")
        .select("is_primary")
        .where("tenant_id", "=", tenant.id)
        .where("node_id", "=", node2.id)
        .executeTakeFirst();

      t.equal(newPrimary?.is_primary, true);
    },
  );
});

await t.test("handles invalid/NaN IDs", async (t) => {
  await t.test(
    "GET /api/tenants/:id with invalid ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/invalid", {
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "GET /api/tenants/:id with negative ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/-1", {
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test("GET /api/tenants/:id with float ID returns 404", async (t) => {
    const token = await createAdminUser();
    const res = await app.request("/api/tenants/1.5", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test(
    "PUT /api/tenants/:id with invalid ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/abc", {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "updated" }),
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "DELETE /api/tenants/:id with invalid ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/invalid", {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "GET /api/tenants/:id/nodes with invalid ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/invalid/nodes", {
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "POST /api/tenants/:id/nodes with invalid tenant ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/invalid/nodes", {
        method: "POST",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ node_id: 1 }),
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "DELETE /api/tenants/:id/nodes/:nodeId with invalid tenant ID returns 404",
    async (t) => {
      const token = await createAdminUser();
      const res = await app.request("/api/tenants/invalid/nodes/1", {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test(
    "DELETE /api/tenants/:id/nodes/:nodeId with invalid node ID returns 404",
    async (t) => {
      const token = await createAdminUser();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "test-tenant",
          backend_url: "http://backend.com",
          default_price: 0.01,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const res = await app.request(`/api/tenants/${tenant.id}/nodes/invalid`, {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 404);
    },
  );

  await t.test("handles very large ID gracefully", async (t) => {
    const token = await createAdminUser();
    const res = await app.request("/api/tenants/999999999999999", {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 404);
  });
});

await t.test("DELETE /api/tenants/:id/nodes/:nodeId", async (t) => {
  await t.test("returns 404 for non-existent tenant", async (t) => {
    const token = await createAdminUser();

    const res = await app.request("/api/tenants/999/nodes/1", {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 404);
  });

  await t.test("returns 404 for non-existent assignment", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "tenant-x",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/nodes/999`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });

    t.equal(res.status, 404);
  });

  await t.test("removes node assignment", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "remove-node",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "node-to-remove",
        internal_ip: "10.0.0.2",
        public_ip: "2.3.4.5",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        is_primary: false,
      })
      .execute();

    const res = await app.request(
      `/api/tenants/${tenant.id}/nodes/${node.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      },
    );

    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);

    const check = await db
      .selectFrom("tenant_nodes")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .where("node_id", "=", node.id)
      .executeTakeFirst();
    t.equal(check, undefined);
  });

  await t.test("can remove the last node from a tenant", async (t) => {
    const token = await createAdminUser();

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "single-node-tenant",
        backend_url: "http://backend.com",
        default_price: 0.01,
        default_scheme: "exact",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const node = await db
      .insertInto("nodes")
      .values({
        name: "only-node",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("tenant_nodes")
      .values({
        tenant_id: tenant.id,
        node_id: node.id,
        is_primary: true,
      })
      .execute();

    const res = await app.request(
      `/api/tenants/${tenant.id}/nodes/${node.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      },
    );

    t.equal(res.status, 200);
    const data = DeleteResponse.assert(await res.json());
    t.equal(data.deleted, true);

    const nodes = await db
      .selectFrom("tenant_nodes")
      .select("id")
      .where("tenant_id", "=", tenant.id)
      .execute();
    t.equal(nodes.length, 0);
  });

  await t.test(
    "removing primary node leaves tenant with no primary",
    async (t) => {
      const token = await createAdminUser();

      const tenant = await db
        .insertInto("tenants")
        .values({
          name: "multi-node-tenant",
          backend_url: "http://backend.com",
          default_price: 0.01,
          default_scheme: "exact",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const primaryNode = await db
        .insertInto("nodes")
        .values({
          name: "primary-node",
          internal_ip: "10.0.0.1",
          public_ip: "1.2.3.4",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const secondaryNode = await db
        .insertInto("nodes")
        .values({
          name: "secondary-node",
          internal_ip: "10.0.0.2",
          public_ip: "2.3.4.5",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("tenant_nodes")
        .values([
          { tenant_id: tenant.id, node_id: primaryNode.id, is_primary: true },
          {
            tenant_id: tenant.id,
            node_id: secondaryNode.id,
            is_primary: false,
          },
        ])
        .execute();

      const res = await app.request(
        `/api/tenants/${tenant.id}/nodes/${primaryNode.id}`,
        {
          method: "DELETE",
          headers: { Cookie: `auth_token=${token}` },
        },
      );

      t.equal(res.status, 200);

      const remaining = await db
        .selectFrom("tenant_nodes")
        .select(["node_id", "is_primary"])
        .where("tenant_id", "=", tenant.id)
        .execute();

      t.equal(remaining.length, 1);
      const first = remaining[0];
      t.ok(first);
      t.equal(first?.node_id, secondaryNode.id);
      t.equal(first?.is_primary, false);
    },
  );
});

await t.test("org role-based access control", async (t) => {
  await t.test("member can GET tenant (read-only)", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const res = await app.request(`/api/tenants/${tenantId}`, {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
  });

  await t.test("member cannot PUT tenant (admin-only)", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const res = await app.request(`/api/tenants/${tenantId}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend_url: "http://member-updated.com" }),
    });
    t.equal(res.status, 403);
  });

  await t.test("member cannot DELETE tenant (admin-only)", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const res = await app.request(`/api/tenants/${tenantId}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 403);
  });

  await t.test(
    "org admin cannot PUT tenant (platform admin-only)",
    async (t) => {
      const { token, tenantId } = await createOrgMemberWithTenant("admin");

      const res = await app.request(`/api/tenants/${tenantId}`, {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ backend_url: "http://updated.com" }),
      });
      t.equal(res.status, 403);
    },
  );

  await t.test(
    "org admin cannot DELETE tenant (platform admin-only)",
    async (t) => {
      const { token, tenantId } = await createOrgMemberWithTenant("admin");

      const res = await app.request(`/api/tenants/${tenantId}`, {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 403);
    },
  );

  await t.test("owner cannot PUT tenant (platform admin-only)", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("owner");

    const res = await app.request(`/api/tenants/${tenantId}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend_url: "http://owner-updated.com" }),
    });
    t.equal(res.status, 403);
  });

  await t.test(
    "owner cannot DELETE tenant (platform admin-only)",
    async (t) => {
      const { token, tenantId } = await createOrgMemberWithTenant("owner");

      const res = await app.request(`/api/tenants/${tenantId}`, {
        method: "DELETE",
        headers: { Cookie: `auth_token=${token}` },
      });
      t.equal(res.status, 403);
    },
  );

  await t.test("member can GET nodes (read-only)", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const res = await app.request(`/api/tenants/${tenantId}/nodes`, {
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
  });

  await t.test("member can POST nodes", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const node = await db
      .insertInto("nodes")
      .values({
        name: "member-node",
        internal_ip: "10.0.0.1",
        public_ip: "1.2.3.4",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenantId}/nodes`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: node.id }),
    });
    t.equal(res.status, 201);
  });

  await t.test("member can DELETE nodes", async (t) => {
    const { token, tenantId } = await createOrgMemberWithTenant("member");

    const node = await db
      .insertInto("nodes")
      .values({
        name: "member-del-node",
        internal_ip: "10.0.0.2",
        public_ip: "2.3.4.5",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("tenant_nodes")
      .values({ tenant_id: tenantId, node_id: node.id, is_primary: false })
      .execute();

    const res = await app.request(`/api/tenants/${tenantId}/nodes/${node.id}`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${token}` },
    });
    t.equal(res.status, 200);
  });
});
