import "../tests/setup/env.js";
import t from "tap";
import { type } from "arktype";
import { Hono } from "hono";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { signToken } from "../middleware/auth.js";
import { endpointsRoutes } from "./endpoints.js";
import { OPENAPI_USPTO } from "../tests/fixtures/openapi-spec.js";
import { isRecord } from "../lib/pricing-rules.js";

const EndpointResponse = type({
  id: "number",
  http_method: "string",
  "path?": "string | null",
  "path_pattern?": "string",
  "price?": "number | null",
  "scheme?": "string | null",
  "priority?": "number",
  "is_active?": "boolean",
  "openapi_source_paths?": "string[] | null",
  "tags?": "string[]",
  "deleted_at?": "string | null",
  "description?": "string | null",
  "+": "delete",
});

const ErrorResponse = type({ error: "string", "+": "delete" });

const DeleteEndpointResponse = type({
  deleted: "boolean",
  endpoint: {
    "is_active?": "boolean",
    "deleted_at?": "string | null",
    "+": "delete",
  },
  "+": "delete",
});

const EndpointStatsResponse = type({
  endpoint_id: "number",
  total_transactions: "number",
  total_spent: "number",
  period: { from: "string | null", to: "string | null", "+": "delete" },
  "path_pattern?": "string",
  "+": "delete",
});

const TransactionItem = type({
  id: "number",
  "endpoint_id?": "number | null",
  tenant_id: "number",
  amount: "number",
  ngx_request_id: "string",
  request_path: "string",
  "organization_id?": "number | null",
  "tx_hash?": "string | null",
  "network?": "string | null",
  "token_symbol?": "string | null",
  "mint_address?": "string | null",
  "created_at?": "string",
  "+": "delete",
});

const OpenApiSpec = type({
  paths: "Record<string, unknown>",
  "+": "delete",
});

const PathItem = type({
  "get?": { "summary?": "string", "+": "delete" },
  "post?": { "summary?": "string", "+": "delete" },
  "put?": { "summary?": "string", "+": "delete" },
  "delete?": { "summary?": "string", "+": "delete" },
  "+": "delete",
});

function pathItem(val: unknown) {
  return PathItem.assert(val);
}

const app = new Hono();
app.route("/api/tenants/:tenantId/endpoints", endpointsRoutes);

await setupTestSchema();

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

async function addMember(userId: number, orgId: number, role = "member") {
  await db
    .insertInto("user_organizations")
    .values({ user_id: userId, organization_id: orgId, role })
    .execute();
}

async function createTenant(orgId: number, name: string) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: "http://backend.example.com",
      default_price: 0.01,
      default_scheme: "exact",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createEndpoint(
  tenantId: number,
  path: string,
  opts: { priority?: number; is_active?: boolean; price?: number } = {},
) {
  return db
    .insertInto("endpoints")
    .values({
      tenant_id: tenantId,
      path,
      path_pattern: path,
      priority: opts.priority ?? 100,
      is_active: opts.is_active ?? true,
      price: opts.price ?? 0.01,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function createNode(name: string) {
  return db
    .insertInto("nodes")
    .values({
      name,
      internal_ip: "10.0.0.1",
      status: "active",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function linkTenantToNode(tenantId: number, nodeId: number) {
  await db
    .insertInto("tenant_nodes")
    .values({ tenant_id: tenantId, node_id: nodeId })
    .execute();
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("GET /api/tenants/:tenantId/endpoints", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/tenants/1/endpoints");
    t.equal(res.status, 401);
  });

  await t.test("returns 404 for non-existent tenant (non-admin)", async (t) => {
    const user = await createUser("user@example.com");
    const res = await app.request("/api/tenants/999/endpoints", {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns 403 for non-member", async (t) => {
    const user = await createUser("outsider@example.com");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 403);
  });

  await t.test("returns empty list for member", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = EndpointResponse.array().assert(await res.json());
    t.same(data, []);
  });

  await t.test("returns endpoints sorted by priority", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await createEndpoint(tenant.id, "/low-priority", { priority: 200 });
    await createEndpoint(tenant.id, "/high-priority", { priority: 50 });
    await createEndpoint(tenant.id, "/medium-priority", { priority: 100 });

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = EndpointResponse.array().assert(await res.json());
    t.equal(data.length, 3);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].path, "/high-priority");
    if (!data[1]) throw new Error("expected data[1]");
    t.equal(data[1].path, "/medium-priority");
    if (!data[2]) throw new Error("expected data[2]");
    t.equal(data[2].path, "/low-priority");
  });

  await t.test("excludes deleted endpoints by default", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await createEndpoint(tenant.id, "/active", { is_active: true });
    await createEndpoint(tenant.id, "/deleted", { is_active: false });

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = EndpointResponse.array().assert(await res.json());
    t.equal(data.length, 1);
    if (!data[0]) throw new Error("expected data[0]");
    t.equal(data[0].path, "/active");
  });

  await t.test("includes deleted endpoints when requested", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await createEndpoint(tenant.id, "/active", { is_active: true });
    await createEndpoint(tenant.id, "/deleted", { is_active: false });

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints?include_deleted=true`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 200);
    const data = EndpointResponse.array().assert(await res.json());
    t.equal(data.length, 2);
  });

  await t.test("admin can access any tenant", async (t) => {
    const admin = await createUser("admin@example.com", true);
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    await createEndpoint(tenant.id, "/test");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      headers: { Cookie: `auth_token=${admin.token}` },
    });
    t.equal(res.status, 200);
    const data = EndpointResponse.array().assert(await res.json());
    t.equal(data.length, 1);
  });
});

await t.test("GET /api/tenants/:tenantId/endpoints/:id", async (t) => {
  await t.test("returns 404 for non-existent endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints/999`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 404);
  });

  await t.test("returns 404 for endpoint in different tenant", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant1 = await createTenant(org.id, "tenant-1");
    const tenant2 = await createTenant(org.id, "tenant-2");

    const endpoint = await createEndpoint(tenant2.id, "/other-tenant");

    const res = await app.request(
      `/api/tenants/${tenant1.id}/endpoints/${endpoint.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 404);
  });

  await t.test("returns endpoint details", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/users/list", {
      price: 0.05,
      priority: 50,
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/users/list");
    t.equal(data.price, 0.05);
    t.equal(data.priority, 50);
  });
});

await t.test("POST /api/tenants/:tenantId/endpoints", async (t) => {
  await t.test("creates endpoint with literal path", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/users/list",
        price: 0.02,
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/users/list");
    t.equal(data.path_pattern, "/users/list");
    t.equal(data.price, 0.02);
    t.equal(data.is_active, true);
  });

  await t.test("creates endpoint with OpenAPI-style path", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/users/{userId}/orders/{orderId}",
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/users/{userId}/orders/{orderId}");
    t.equal(data.path_pattern, "^/users/[^/]+/orders/[^/]+$");
  });

  await t.test("creates endpoint and pricing rules atomically", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

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

    const rules = [
      {
        match: "$",
        authorize: "1000000",
        capture: "$.response.body.data.length * 10000",
      },
    ];

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/v1/items",
        scheme: "flex",
        http_method: "POST",
        openapi_source_paths: ["/v1/items"],
        pricing_rules: rules,
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/v1/items");

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

  await t.test(
    "preserves imported pricing when endpoint create omits inline rules",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const importedRules = [
        {
          match: "$",
          authorize: "1000000",
          capture: "$.response.body.total * 10000",
        },
      ];

      await db
        .updateTable("tenants")
        .set({
          openapi_spec: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "API", version: "1.0.0" },
            paths: {
              "/v1/items": {
                post: {
                  summary: "Items",
                  "x-faremeter-pricing": { rules: importedRules },
                },
              },
            },
          }),
        })
        .where("id", "=", tenant.id)
        .execute();

      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "/v1/items",
          scheme: "flex",
          http_method: "POST",
          openapi_source_paths: ["/v1/items"],
        }),
      });

      t.equal(res.status, 201);

      const updated = await db
        .selectFrom("tenants")
        .select("openapi_spec")
        .where("id", "=", tenant.id)
        .executeTakeFirstOrThrow();
      const spec = OpenApiSpec.assert(updated.openapi_spec);
      const itemsPath = spec.paths["/v1/items"];
      if (!isRecord(itemsPath)) {
        throw new Error("expected /v1/items path item");
      }
      const postOperation = itemsPath.post;
      if (!isRecord(postOperation)) {
        throw new Error("expected POST operation");
      }
      const pricing = postOperation["x-faremeter-pricing"];
      t.same(pricing, { rules: importedRules });
    },
  );

  await t.test(
    "does not create endpoint when inline pricing rules are invalid",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

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

      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "/v1/items",
          scheme: "flex",
          http_method: "POST",
          openapi_source_paths: ["/v1/items"],
          pricing_rules: [
            { match: "$", capture: "$.response.body.data.length *" },
          ],
        }),
      });

      t.equal(res.status, 400);
      const endpoints = await db
        .selectFrom("endpoints")
        .select("id")
        .where("tenant_id", "=", tenant.id)
        .execute();
      t.same(endpoints, []);
    },
  );

  await t.test("creates endpoint with regex path", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "^/api/v[0-9]+/users$",
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "^/api/v[0-9]+/users$");
    t.equal(data.path_pattern, "^/api/v[0-9]+/users$");
  });

  await t.test("rejects unsafe regex patterns", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "^(a+)+$",
      }),
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("performance"));
  });

  await t.test("rejects catch-all patterns", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const catchAllPatterns = ["/", "/*", "^/$", "^/.*$"];

    for (const pattern of catchAllPatterns) {
      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: pattern }),
      });

      t.equal(res.status, 400, `should reject ${pattern}`);
      const data = ErrorResponse.assert(await res.json());
      t.ok(data.error.includes("catch-all"));
    }
  });

  await t.test("creates endpoint with all fields", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/premium/endpoint",
        price: 1.5,
        scheme: "exact",
        description: "Premium API endpoint",
        priority: 10,
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.price, 1.5);
    t.equal(data.scheme, "exact");
    t.equal(data.description, "Premium API endpoint");
    t.equal(data.priority, 10);
  });

  await t.test("allows creating endpoint on registered tenant", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);

    const tenant = await db
      .insertInto("tenants")
      .values({
        name: "registered-tenant",
        organization_id: org.id,
        backend_url: "http://backend.example.com",
        default_price: 0.01,
        default_scheme: "exact",
        status: "registered",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/api/test",
        price: 0.05,
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/api/test");
  });

  await t.test("rejects invalid JSON", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: "{ invalid json }",
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects empty body", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects missing path field", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ price: 0.05 }),
    });

    t.equal(res.status, 400);
  });

  await t.test("accepts openapi_source_paths field", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const sourcePaths = Object.keys(OPENAPI_USPTO.paths);

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/{dataset}/{version}/fields",
        openapi_source_paths: sourcePaths,
        description: "USPTO dataset fields endpoint",
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/{dataset}/{version}/fields");
    t.same(data.openapi_source_paths, sourcePaths);
  });

  await t.test("creates endpoint with http_method", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/get-only",
        http_method: "GET",
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.http_method, "GET");
  });

  await t.test("defaults http_method to ANY when omitted", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/any-method",
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.http_method, "ANY");
  });

  await t.test("creates endpoint with tags", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/tagged-endpoint",
        tags: ["production", "api"],
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.same(data.tags, ["production", "api"]);
  });

  await t.test(
    "creates endpoint with empty tags defaults to empty array",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "/no-tags",
        }),
      });

      t.equal(res.status, 201);
      const data = EndpointResponse.assert(await res.json());
      t.same(data.tags, []);
    },
  );

  await t.test("rejects invalid tags on create", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/bad-tags",
        tags: ["UPPERCASE", "invalid tag!"],
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("rejects too many tags on create", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/too-many-tags",
        tags: ["t1", "t2", "t3", "t4", "t5", "t6"],
      }),
    });

    t.equal(res.status, 400);
  });

  await t.test("accepts null for openapi_source_paths", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: "/null-openapi-test",
        openapi_source_paths: null,
      }),
    });

    t.equal(res.status, 201);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/null-openapi-test");
    t.equal(data.openapi_source_paths, null);
  });

  await t.test("triggers node sync after creation", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("test-node");
    await linkTenantToNode(tenant.id, node.id);

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "/sync-test" }),
    });

    t.equal(res.status, 201);
  });
});

await t.test("PUT /api/tenants/:tenantId/endpoints/:id", async (t) => {
  await t.test("returns 404 for non-existent endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints/999`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ price: 0.05 }),
    });

    t.equal(res.status, 404);
  });

  await t.test("updates endpoint fields", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/old-path", {
      price: 0.01,
      priority: 100,
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "/new-path",
          price: 0.1,
          priority: 50,
          description: "Updated description",
        }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/new-path");
    t.equal(data.price, 0.1);
    t.equal(data.priority, 50);
    t.equal(data.description, "Updated description");
  });

  await t.test("updates endpoint and pricing rules atomically", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
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
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: "Updated with rules",
          pricing_rules: rules,
        }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.description, "Updated with rules");

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

  await t.test(
    "does not update endpoint fields when inline pricing rules are invalid",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
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
          description: "Original",
          openapi_source_paths: ["/v1/items"],
          http_method: "POST",
        })
        .where("id", "=", endpoint.id)
        .execute();

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            description: "Should not persist",
            pricing_rules: [
              { match: "$", capture: "$.response.body.data.length *" },
            ],
          }),
        },
      );

      t.equal(res.status, 400);
      const unchanged = await db
        .selectFrom("endpoints")
        .select("description")
        .where("id", "=", endpoint.id)
        .executeTakeFirstOrThrow();
      t.equal(unchanged.description, "Original");
    },
  );

  await t.test("updates http_method", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    // Create via POST (defaults to ANY)
    const createRes = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "/method-test" }),
    });
    t.equal(createRes.status, 201);
    const created = EndpointResponse.assert(await createRes.json());
    t.equal(created.http_method, "ANY");

    // Update to POST
    const updateRes = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${created.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ http_method: "POST" }),
      },
    );
    t.equal(updateRes.status, 200);
    const updated = EndpointResponse.assert(await updateRes.json());
    t.equal(updated.http_method, "POST");
  });

  await t.test("supports partial updates", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/my-path", {
      price: 0.01,
      priority: 100,
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ priority: 25 }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.path, "/my-path");
    t.equal(data.price, 0.01);
    t.equal(data.priority, 25);
  });

  await t.test("can deactivate endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/my-path");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ is_active: false }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.is_active, false);
  });

  await t.test("rejects unsafe regex on update", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/safe-path");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "^(a+)+$" }),
      },
    );

    t.equal(res.status, 400);
  });

  await t.test("updates scheme field", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/my-path");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scheme: "exact" }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.equal(data.scheme, "exact");
  });

  await t.test("updates tags", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/tag-update");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: ["production", "v2"] }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.same(data.tags, ["production", "v2"]);
  });

  await t.test("clears tags with empty array", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/tag-clear");

    // First set tags
    await app.request(`/api/tenants/${tenant.id}/endpoints/${endpoint.id}`, {
      method: "PUT",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["production"] }),
    });

    // Then clear them
    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: [] }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.same(data.tags, []);
  });

  await t.test("rejects invalid tags on update", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/bad-tag-update");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: ["INVALID"] }),
      },
    );

    t.equal(res.status, 400);
  });

  await t.test("updates openapi_source_paths field", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/my-path");
    const sourcePaths = Object.keys(OPENAPI_USPTO.paths);

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ openapi_source_paths: sourcePaths }),
      },
    );

    t.equal(res.status, 200);
    const data = EndpointResponse.assert(await res.json());
    t.same(data.openapi_source_paths, sourcePaths);
  });

  await t.test("triggers node sync after update", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("test-node");
    await linkTenantToNode(tenant.id, node.id);
    const endpoint = await createEndpoint(tenant.id, "/sync-update");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "PUT",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ price: 0.99 }),
      },
    );

    t.equal(res.status, 200);
  });
});

await t.test(
  "GET /api/tenants/:tenantId/endpoints/:id/pricing-rules",
  async (t) => {
    await t.test("returns rules for OpenAPI-backed endpoint", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
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
                post: {
                  "x-faremeter-pricing": {
                    rules: [{ match: "$", capture: "10000" }],
                  },
                },
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

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/pricing-rules`,
        {
          headers: { Cookie: `auth_token=${user.token}` },
        },
      );

      t.equal(res.status, 200);
      const data = (await res.json()) as {
        rules: unknown[];
        editable: boolean;
      };
      t.equal(data.editable, true);
      t.same(data.rules, [{ match: "$", capture: "10000" }]);
    });

    await t.test("returns inherited root pricing rules", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/v1/items");

      await db
        .updateTable("tenants")
        .set({
          openapi_spec: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "API", version: "1.0.0" },
            "x-faremeter-pricing": {
              rules: [{ match: "$", capture: "20000" }],
            },
            paths: {
              "/v1/items": {
                post: {
                  summary: "Items",
                },
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

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/pricing-rules`,
        {
          headers: { Cookie: `auth_token=${user.token}` },
        },
      );

      t.equal(res.status, 200);
      const data = (await res.json()) as {
        rules: unknown[];
        editable: boolean;
      };
      t.equal(data.editable, true);
      t.same(data.rules, [{ match: "$", capture: "20000" }]);
    });

    await t.test("marks orphan endpoint as not editable", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/manual");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/pricing-rules`,
        {
          headers: { Cookie: `auth_token=${user.token}` },
        },
      );

      t.equal(res.status, 200);
      const data = (await res.json()) as {
        rules: unknown[];
        editable: boolean;
        reason: string;
      };
      t.equal(data.editable, false);
      t.same(data.rules, []);
      t.match(data.reason, /OpenAPI-backed/);
    });
  },
);

await t.test(
  "PUT /api/tenants/:tenantId/endpoints/:id/pricing-rules",
  async (t) => {
    await t.test("updates operation pricing rules", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
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
                post: {
                  summary: "Items",
                },
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
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/pricing-rules`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rules }),
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
      const post = spec.paths["/v1/items"]?.post;
      if (!post) throw new Error("expected POST operation");
      const pricing = post["x-faremeter-pricing"] as Record<string, unknown>;
      t.same(pricing.rules, rules);
    });

    await t.test("rejects invalid pricing expressions", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
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
                post: {
                  summary: "Items",
                },
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

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/pricing-rules`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rules: [{ match: "$", capture: "$.response.body.data.length *" }],
          }),
        },
      );

      t.equal(res.status, 400);
      const data = ErrorResponse.assert(await res.json());
      t.match(data.error, /must not reference \$\.response/);
    });
  },
);

await t.test("DELETE /api/tenants/:tenantId/endpoints/:id", async (t) => {
  await t.test("returns 404 for non-existent endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/endpoints/999`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${user.token}` },
    });

    t.equal(res.status, 404);
  });

  await t.test("soft deletes endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/to-delete");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );

    t.equal(res.status, 200);
    const data = DeleteEndpointResponse.assert(await res.json());
    t.equal(data.deleted, true);
    t.equal(data.endpoint.is_active, false);
    t.ok(data.endpoint.deleted_at);
  });

  await t.test("returns 404 for already deleted endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/deleted", {
      is_active: false,
    });

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );

    t.equal(res.status, 404);
  });

  await t.test("triggers node sync after deletion", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");
    const node = await createNode("test-node");
    await linkTenantToNode(tenant.id, node.id);
    const endpoint = await createEndpoint(tenant.id, "/sync-delete");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
      {
        method: "DELETE",
        headers: { Cookie: `auth_token=${user.token}` },
      },
    );

    t.equal(res.status, 200);
  });
});

await t.test("GET /api/tenants/:tenantId/endpoints/:id/stats", async (t) => {
  await t.test("returns 404 for non-existent endpoint", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/999/stats`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );

    t.equal(res.status, 404);
  });

  await t.test("returns stats for endpoint with no transactions", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/stats-test");

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );

    t.equal(res.status, 200);
    const data = EndpointStatsResponse.assert(await res.json());
    t.equal(data.endpoint_id, endpoint.id);
    t.equal(data.total_transactions, 0);
    t.equal(data.total_spent, 0);
  });

  await t.test("returns stats with transactions", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/stats-test");

    await db
      .insertInto("transactions")
      .values([
        {
          tenant_id: tenant.id,
          endpoint_id: endpoint.id,
          amount: 0.05,
          ngx_request_id: "req-1",
          request_path: "/stats-test",
        },
        {
          tenant_id: tenant.id,
          endpoint_id: endpoint.id,
          amount: 0.1,
          ngx_request_id: "req-2",
          request_path: "/stats-test",
        },
      ])
      .execute();

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );

    t.equal(res.status, 200);
    const data = EndpointStatsResponse.assert(await res.json());
    t.equal(data.total_transactions, 2);
    t.ok(
      Math.abs(data.total_spent - 0.15) < 0.001,
      `expected ~0.15, got ${data.total_spent}`,
    );
  });

  await t.test("filters stats by date range", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const endpoint = await createEndpoint(tenant.id, "/date-filter");

    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const tomorrow = new Date(now.getTime() + 86400000);

    await db
      .insertInto("transactions")
      .values({
        tenant_id: tenant.id,
        endpoint_id: endpoint.id,
        amount: 0.05,
        ngx_request_id: "req-date-1",
        request_path: "/date-filter",
      })
      .execute();

    const res = await app.request(
      `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats?from=${yesterday.toISOString()}&to=${tomorrow.toISOString()}`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );

    t.equal(res.status, 200);
    const data = EndpointStatsResponse.assert(await res.json());
    t.equal(data.total_transactions, 1);
    t.ok(data.period.from);
    t.ok(data.period.to);
  });
});

await t.test(
  "GET /api/tenants/:tenantId/endpoints/:id/transactions",
  async (t) => {
    await t.test("returns 404 for non-existent endpoint", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/999/transactions`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 404);
    });

    await t.test("returns empty list for no transactions", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/no-txns");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
      const data = TransactionItem.array().assert(await res.json());
      t.same(data, []);
    });

    await t.test("returns transactions for endpoint", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/with-txns");

      await db
        .insertInto("transactions")
        .values([
          {
            tenant_id: tenant.id,
            endpoint_id: endpoint.id,
            amount: 0.05,
            ngx_request_id: "req-txn-1",
            request_path: "/with-txns",
          },
          {
            tenant_id: tenant.id,
            endpoint_id: endpoint.id,
            amount: 0.1,
            ngx_request_id: "req-txn-2",
            request_path: "/with-txns",
          },
        ])
        .execute();

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
      const data = TransactionItem.array().assert(await res.json());
      t.equal(data.length, 2);
    });

    await t.test("supports pagination", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/paginated");

      for (let i = 0; i < 5; i++) {
        await db
          .insertInto("transactions")
          .values({
            tenant_id: tenant.id,
            endpoint_id: endpoint.id,
            amount: 0.01 * (i + 1),
            ngx_request_id: `req-page-${i}`,
            request_path: "/paginated",
          })
          .execute();
      }

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions?limit=2&offset=1`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
      const data = TransactionItem.array().assert(await res.json());
      t.equal(data.length, 2);
    });

    await t.test("invalid limit defaults to 50", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/invalid-limit");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions?limit=invalid`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
    });

    await t.test("negative offset floors at 0", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/neg-offset");

      await db
        .insertInto("transactions")
        .values({
          tenant_id: tenant.id,
          endpoint_id: endpoint.id,
          amount: 0.01,
          ngx_request_id: "req-neg",
          request_path: "/neg-offset",
        })
        .execute();

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions?offset=-10`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
      const data = TransactionItem.array().assert(await res.json());
      t.equal(data.length, 1);
    });

    await t.test("limit capped at MAX_PAGINATION_LIMIT", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/max-limit");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/transactions?limit=9999`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
    });
  },
);

await t.test(
  "POST /api/tenants/:tenantId/endpoints - path edge cases",
  async (t) => {
    await t.test("accepts path with unicode characters", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "/api/usuarios/cafe",
        }),
      });

      t.equal(res.status, 201);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.path, "/api/usuarios/cafe");
    });

    await t.test("accepts very long path", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const longPath = "/api/" + "segment/".repeat(50) + "end";

      const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: longPath }),
      });

      t.equal(res.status, 201);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.path, longPath);
    });

    await t.test(
      "accepts OpenAPI-style path with multiple params",
      async (t) => {
        const user = await createUser("member@example.com");
        const org = await createOrg("Team", "team");
        await addMember(user.id, org.id);
        const tenant = await createTenant(org.id, "my-tenant");

        const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "/users/{userId}/posts/{postId}/comments/{commentId}",
          }),
        });

        t.equal(res.status, 201);
        const data = EndpointResponse.assert(await res.json());
        t.equal(
          data.path,
          "/users/{userId}/posts/{postId}/comments/{commentId}",
        );
      },
    );
  },
);

await t.test(
  "PUT /api/tenants/:tenantId/endpoints/:id - clearing fields",
  async (t) => {
    await t.test("can set price to null", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await createEndpoint(tenant.id, "/priced-endpoint", {
        price: 0.05,
      });

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ price: null }),
        },
      );

      t.equal(res.status, 200);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.price, null);
    });

    await t.test("can set scheme to null", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const endpoint = await db
        .insertInto("endpoints")
        .values({
          tenant_id: tenant.id,
          path: "/schemed-endpoint",
          path_pattern: "/schemed-endpoint",
          priority: 100,
          is_active: true,
          scheme: "exact",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scheme: null }),
        },
      );

      t.equal(res.status, 200);
      const data = EndpointResponse.assert(await res.json());
      t.equal(data.scheme, null);
    });
  },
);

await t.test(
  "GET /api/tenants/:tenantId/endpoints/:id/stats - date edge cases",
  async (t) => {
    await t.test("handles invalid from date format gracefully", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/date-test");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats?from=not-a-date`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
    });

    await t.test("handles invalid to date format gracefully", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/date-test");

      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats?to=garbage`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
    });

    await t.test("handles from > to date range (returns empty)", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const endpoint = await createEndpoint(tenant.id, "/backwards-date");

      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);

      // from is in the future, to is in the past (backwards range)
      const res = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${endpoint.id}/stats?from=${now.toISOString()}&to=${yesterday.toISOString()}`,
        { headers: { Cookie: `auth_token=${user.token}` } },
      );

      t.equal(res.status, 200);
      const data = EndpointStatsResponse.assert(await res.json());
      // Backwards range returns 0 results
      t.equal(data.total_transactions, 0);
    });
  },
);

await t.test(
  "OpenAPI spec auto-generation on endpoint mutations",
  async (t) => {
    await t.test(
      "POST creates endpoint and generates OpenAPI spec",
      async (t) => {
        const user = await createUser("member@example.com");
        const org = await createOrg("Team", "team");
        await addMember(user.id, org.id);
        const tenant = await createTenant(org.id, "my-tenant");

        const res = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "/users/{id}",
            price: 100,
            scheme: "exact",
            description: "Get user by ID",
          }),
        });
        t.equal(res.status, 201);

        // Wait for fire-and-forget sync to complete
        await new Promise((r) => setTimeout(r, 100));

        const tenantRow = await db
          .selectFrom("tenants")
          .select(["openapi_spec"])
          .where("id", "=", tenant.id)
          .executeTakeFirst();

        if (!tenantRow) {
          t.fail("expected tenantRow");
          return;
        }
        const spec = OpenApiSpec.assert(tenantRow.openapi_spec);
        t.ok(spec.paths["/users/{id}"]);
        t.equal(
          pathItem(spec.paths["/users/{id}"]).get?.summary,
          "Get user by ID",
        );
      },
    );

    await t.test("PUT updates endpoint and updates OpenAPI spec", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Create endpoint via API
      const createRes = await app.request(
        `/api/tenants/${tenant.id}/endpoints`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "/old-path",
            description: "Old endpoint",
          }),
        },
      );
      const created = EndpointResponse.assert(await createRes.json());
      await new Promise((r) => setTimeout(r, 100));

      // Update path
      const updateRes = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${created.id}`,
        {
          method: "PUT",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: "/new-path",
            description: "Updated endpoint",
          }),
        },
      );
      t.equal(updateRes.status, 200);
      await new Promise((r) => setTimeout(r, 100));

      const tenantRow = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();

      if (!tenantRow) {
        t.fail("expected tenantRow");
        return;
      }
      const spec = OpenApiSpec.assert(tenantRow.openapi_spec);
      t.notOk(spec.paths["/old-path"]);
      t.ok(spec.paths["/new-path"]);
      t.equal(
        pathItem(spec.paths["/new-path"]).get?.summary,
        "Updated endpoint",
      );
    });

    await t.test("DELETE removes endpoint from OpenAPI spec", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Create two endpoints
      const res1 = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "/keep-me" }),
      });
      await res1.json();

      const res2 = await app.request(`/api/tenants/${tenant.id}/endpoints`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "/delete-me" }),
      });
      const ep2 = EndpointResponse.assert(await res2.json());
      await new Promise((r) => setTimeout(r, 100));

      // Delete second endpoint
      const deleteRes = await app.request(
        `/api/tenants/${tenant.id}/endpoints/${ep2.id}`,
        {
          method: "DELETE",
          headers: { Cookie: `auth_token=${user.token}` },
        },
      );
      t.equal(deleteRes.status, 200);
      await new Promise((r) => setTimeout(r, 100));

      const tenantRow = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();

      if (!tenantRow) {
        t.fail("expected tenantRow");
        return;
      }
      const spec = OpenApiSpec.assert(tenantRow.openapi_spec);
      t.ok(spec.paths["/keep-me"]);
      t.notOk(spec.paths["/delete-me"]);
    });
  },
);
